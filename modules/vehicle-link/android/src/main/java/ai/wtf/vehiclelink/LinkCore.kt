package ai.wtf.vehiclelink

import ai.wtf.vehiclelink.logic.CharacteristicInfo
import ai.wtf.vehiclelink.logic.LinkLogic
import ai.wtf.vehiclelink.logic.ProfileSpec
import ai.wtf.vehiclelink.logic.PromptFramer
import ai.wtf.vehiclelink.logic.ServiceInfo
import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** What JS passes to `connect` (docs/VEHICLE-LINK-SPEC.md §5). */
data class ConnectRequest(
  val id: String,
  val transport: String,
  val profiles: List<ProfileSpec>,
  val preferred: List<String>?,
  /** 0 = no timeout (pending connect, used for reconnects). */
  val timeoutMs: Long,
)

// Thin transport for ELM327 adapters on Android (docs/ANDROID-SPEC.md §3 C): BLE (BluetoothGatt) and Classic
// Bluetooth SPP (RFCOMM). Scan, connect, write, frame on the ELM `>` prompt, timestamp with the monotonic clock.
// No protocol logic here; UART selection, chunking and framing are in logic/ (unit-tested on the JVM).
// All state lives on one handler thread; Bluetooth callbacks and blocking I/O post onto it.
@SuppressLint("MissingPermission")
class LinkCore(private val context: Context, private val emit: (String, Map<String, Any?>) -> Unit) {
  companion object {
    const val TAG = "WtfVehicleLink"
    val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")
    private const val BLE_MTU = 247
    private const val MAX_GATT_RETRIES = 2
    private const val SPP_RETRY_MS = 3000L

    fun nowUs(): Double = SystemClock.elapsedRealtimeNanos() / 1000.0
  }

  private val thread = HandlerThread("ai.wtf.vehiclelink").also { it.start() }
  private val handler = Handler(thread.looper)
  private val io = Executors.newCachedThreadPool()
  private val sppWriter = Executors.newSingleThreadExecutor()
  private val adapter: BluetoothAdapter? get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  private enum class Kind { NONE, BLE, SPP }

  private var kind = Kind.NONE
  private var linkUp = false
  private var connectPromise: Promise? = null
  private var connectRequest: ConnectRequest? = null
  private var connectTimer: Runnable? = null
  private var connectGeneration = 0

  // BLE
  private var gatt: BluetoothGatt? = null
  private var notifyChar: BluetoothGattCharacteristic? = null
  private var writeChar: BluetoothGattCharacteristic? = null
  private var mtu = 23
  private var servicesRequested = false
  private var gattRetries = 0
  private var gattDump = mutableListOf<Map<String, Any?>>()
  private var selected: Map<String, Any?> = emptyMap()
  private val bleChunks = ArrayDeque<ByteArray>()
  private var bleWriting = false

  // SPP
  private var socket: BluetoothSocket? = null
  private var sppOut: OutputStream? = null

  // Transactions
  private class Pending(val id: Int, val promise: Promise, val txUs: Double, var rxFirstUs: Double? = null)

  private var pending: Pending? = null
  private var pendingSeq = 0
  private val framer = PromptFramer()

  // Scan
  private var scanning = false
  private val scanBuffer = LinkedHashMap<String, Map<String, Any?>>()
  private var scanFlush: Runnable? = null
  private var receiversRegistered = false
  private val bondWaiters = HashMap<String, CountDownLatch>()

  // --- Permissions and Bluetooth state ----------------------------------------------------------------------------

  private fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  fun hasConnectPermission() = Build.VERSION.SDK_INT < 31 || granted(Manifest.permission.BLUETOOTH_CONNECT)

  /** Before Android 12 scanning needs location instead of the Bluetooth permissions. */
  fun hasScanPermission() =
    if (Build.VERSION.SDK_INT >= 31) granted(Manifest.permission.BLUETOOTH_SCAN) else granted(Manifest.permission.ACCESS_FINE_LOCATION)

  fun bluetoothState(): String {
    val a = adapter ?: return "unsupported"
    if (!hasConnectPermission()) return "notDetermined"
    return stateString(a.state)
  }

  private fun stateString(state: Int) = when (state) {
    BluetoothAdapter.STATE_ON -> "poweredOn"
    BluetoothAdapter.STATE_OFF -> "poweredOff"
    BluetoothAdapter.STATE_TURNING_ON, BluetoothAdapter.STATE_TURNING_OFF -> "resetting"
    else -> "unknown"
  }

  fun initialize(promise: Promise) {
    handler.post {
      registerReceivers()
      val a = adapter
      promise.resolve(
        when {
          a == null -> "unsupported"
          !hasConnectPermission() -> "unauthorized"
          else -> stateString(a.state)
        },
      )
    }
  }

  private fun registerReceivers() {
    if (receiversRegistered) return
    receiversRegistered = true
    val filter = IntentFilter().apply {
      addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
      addAction(BluetoothDevice.ACTION_FOUND)
      addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
      addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
    }
    ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
  }

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
      val action = intent.action ?: return
      val device: BluetoothDevice? = if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
      } else {
        @Suppress("DEPRECATION") intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
      }
      val rssi = intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE).toInt()
      val bondState = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
      val adapterState = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
      handler.post {
        when (action) {
          BluetoothAdapter.ACTION_STATE_CHANGED -> {
            val state = stateString(adapterState)
            emit("onBluetoothState", mapOf("state" to state))
            if (adapterState == BluetoothAdapter.STATE_ON && scanning) startScanLocked()
            if (adapterState != BluetoothAdapter.STATE_ON && kind != Kind.NONE) closeLink("bluetooth $state", true)
          }
          BluetoothDevice.ACTION_FOUND -> if (device != null && device.type != BluetoothDevice.DEVICE_TYPE_LE) {
            val entry = scanEntry(LinkLogic.sppId(device.address), safeName(device), if (rssi == Short.MIN_VALUE.toInt()) null else rssi, "spp", false)
            scanBuffer[LinkLogic.sppId(device.address)] = entry
          }
          BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> if (scanning) adapter?.startDiscovery()
          BluetoothDevice.ACTION_BOND_STATE_CHANGED -> if (device != null) {
            if (bondState == BluetoothDevice.BOND_BONDED || bondState == BluetoothDevice.BOND_NONE) {
              bondWaiters[device.address.uppercase()]?.countDown()
            }
            if (bondState == BluetoothDevice.BOND_BONDED) addBonded(device)
          }
        }
      }
    }
  }

  private fun safeName(d: BluetoothDevice): String? = try {
    d.name
  } catch (e: SecurityException) {
    null
  }

  // --- Scan ---------------------------------------------------------------------------------------------------------

  private fun scanEntry(id: String, name: String?, rssi: Int?, transport: String, bonded: Boolean, services: List<String> = emptyList(), connectable: Boolean = true, mfrHex: String? = null): Map<String, Any?> {
    val e = mutableMapOf<String, Any?>(
      "id" to id,
      "serviceUuids" to services,
      "connectable" to connectable,
      "seenUs" to nowUs(),
      "transport" to transport,
      "bonded" to bonded,
    )
    if (name != null) e["name"] = name
    if (rssi != null) e["rssi"] = rssi
    if (mfrHex != null) e["manufacturerDataHex"] = mfrHex
    return e
  }

  /** Paired adapters are listed first and need no discovery: Classic ones as `spp:<MAC>`, LE-only ones as the bare MAC. */
  private fun addBonded(d: BluetoothDevice) {
    val le = d.type == BluetoothDevice.DEVICE_TYPE_LE
    val id = if (le) d.address else LinkLogic.sppId(d.address)
    scanBuffer[id] = scanEntry(id, safeName(d), null, if (le) "ble" else "spp", true)
  }

  fun startScan() {
    handler.post {
      scanning = true
      registerReceivers()
      startScanLocked()
    }
  }

  fun stopScan() {
    handler.post { stopScanLocked() }
  }

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      val record = result.scanRecord
      val services = record?.serviceUuids?.map { it.uuid.toString().uppercase() } ?: emptyList()
      var mfrHex: String? = null
      record?.manufacturerSpecificData?.let { sparse ->
        if (sparse.size() > 0) {
          val company = sparse.keyAt(0)
          val bytes = byteArrayOf((company and 0xFF).toByte(), ((company shr 8) and 0xFF).toByte()) + (sparse.valueAt(0) ?: ByteArray(0))
          mfrHex = bytes.joinToString("") { "%02X".format(it) }
        }
      }
      val name = record?.deviceName ?: safeName(result.device)
      val connectable = result.isConnectable
      handler.post {
        scanBuffer[result.device.address] = scanEntry(result.device.address, name, result.rssi, "ble", false, services, connectable, mfrHex)
      }
    }

    override fun onScanFailed(errorCode: Int) {
      Log.w(TAG, "BLE scan failed: $errorCode")
    }
  }

  private fun startScanLocked() {
    val a = adapter ?: return
    if (!a.isEnabled || !hasScanPermission()) return
    try {
      if (hasConnectPermission()) a.bondedDevices?.forEach { addBonded(it) }
      a.bluetoothLeScanner?.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCallback)
      if (!a.isDiscovering) a.startDiscovery()
    } catch (e: SecurityException) {
      Log.w(TAG, "scan not permitted: ${e.message}")
    }
    if (scanFlush == null) {
      val r = object : Runnable {
        override fun run() {
          flushScan()
          if (scanFlush != null) handler.postDelayed(this, 250)
        }
      }
      scanFlush = r
      handler.postDelayed(r, 250)
    }
  }

  private fun stopScanLocked() {
    scanning = false
    val a = adapter
    try {
      if (a != null && a.isEnabled && hasScanPermission()) {
        a.bluetoothLeScanner?.stopScan(scanCallback)
        a.cancelDiscovery()
      }
    } catch (e: SecurityException) {
      Log.w(TAG, "stop scan not permitted: ${e.message}")
    }
    scanFlush?.let { handler.removeCallbacks(it) }
    scanFlush = null
    flushScan()
  }

  private fun flushScan() {
    if (scanBuffer.isEmpty()) return
    val batch = scanBuffer.values.toList()
    scanBuffer.clear()
    emit("onScanBatch", mapOf("devices" to batch))
  }

  // --- Connect / disconnect -----------------------------------------------------------------------------------------

  fun connect(request: ConnectRequest, promise: Promise) {
    handler.post {
      closeLink("new connection", false)
      connectRequest = request
      connectPromise = promise
      connectGeneration++
      gattRetries = 0
      if (request.timeoutMs > 0) {
        val timer = Runnable { failConnect("timeout", "connect timed out") }
        connectTimer = timer
        handler.postDelayed(timer, request.timeoutMs)
      }
      if (request.transport == "spp") connectSpp(request, connectGeneration) else connectBle(request)
    }
  }

  fun disconnect(promise: Promise) {
    handler.post {
      failConnect("cancelled", "disconnect requested")
      closeLink("disconnect requested", false)
      promise.resolve(null)
    }
  }

  private fun failConnect(code: String, message: String) {
    val promise = connectPromise ?: return
    connectPromise = null
    connectTimer?.let { handler.removeCallbacks(it) }
    connectTimer = null
    connectGeneration++
    closeGattQuietly()
    closeSocketQuietly()
    kind = Kind.NONE
    Log.w(TAG, "connect failed: $code $message")
    promise.reject(code, message, null)
  }

  private fun succeedConnect(info: Map<String, Any?>) {
    val promise = connectPromise ?: return
    connectPromise = null
    connectTimer?.let { handler.removeCallbacks(it) }
    connectTimer = null
    linkUp = true
    Log.i(TAG, "link up kind=$kind")
    emit("onLinkState", mapOf("state" to "connected"))
    promise.resolve(info)
  }

  private fun closeLink(reason: String, notify: Boolean) {
    val wasUp = linkUp
    linkUp = false
    pending?.let {
      pending = null
      it.promise.reject("link-lost", reason, null)
    }
    framer.reset()
    bleChunks.clear()
    bleWriting = false
    closeGattQuietly()
    closeSocketQuietly()
    if (connectPromise == null) kind = Kind.NONE
    notifyChar = null
    writeChar = null
    if (notify && wasUp) {
      Log.i(TAG, "link down: $reason")
      emit("onLinkState", mapOf("state" to "disconnected", "reason" to reason))
    }
  }

  private fun closeGattQuietly() {
    val g = gatt ?: return
    gatt = null
    try {
      g.disconnect()
      g.close()
    } catch (e: Exception) {
      Log.w(TAG, "gatt close: ${e.message}")
    }
  }

  private fun closeSocketQuietly() {
    val s = socket
    socket = null
    sppOut = null
    try {
      s?.close()
    } catch (e: Exception) {
      Log.w(TAG, "socket close: ${e.message}")
    }
  }

  // --- BLE ----------------------------------------------------------------------------------------------------------

  private fun connectBle(request: ConnectRequest) {
    val a = adapter
    if (a == null || !a.isEnabled) return failConnect("bluetooth-off", "Bluetooth is off")
    if (!hasConnectPermission()) return failConnect("bluetooth-unauthorized", "Bluetooth permission denied")
    val mac = LinkLogic.parseBleId(request.id) ?: return failConnect("device-not-found", "invalid peripheral id")
    val device = try {
      a.getRemoteDevice(mac)
    } catch (e: IllegalArgumentException) {
      return failConnect("device-not-found", "peripheral not found")
    }
    kind = Kind.BLE
    mtu = 23
    servicesRequested = false
    gattDump = mutableListOf()
    gatt = device.connectGatt(context, request.timeoutMs == 0L, gattCallback, BluetoothDevice.TRANSPORT_LE)
  }

  private val gattCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
      handler.post {
        if (g !== gatt) return@post
        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
          if (connectPromise == null) return@post
          if (!g.requestMtu(BLE_MTU)) discoverServicesOnce(g)
          // Some stacks never answer the MTU request: go on after a short wait.
          handler.postDelayed({ if (g === gatt) discoverServicesOnce(g) }, 2000)
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
          if (connectPromise != null) {
            val request = connectRequest
            // A failure status such as 133 on a first attempt is the stack's way of saying "try again".
            if (request != null && gattRetries < MAX_GATT_RETRIES && status != BluetoothGatt.GATT_SUCCESS) {
              gattRetries++
              Log.w(TAG, "gatt connect status $status, retry $gattRetries")
              closeGattQuietly()
              handler.postDelayed({ if (connectPromise != null) connectBle(request) }, 500)
            } else {
              failConnect("connect-failed", "disconnected during setup (status $status)")
            }
          } else {
            closeLink("peripheral disconnected (status $status)", true)
          }
        }
      }
    }

    override fun onMtuChanged(g: BluetoothGatt, newMtu: Int, status: Int) {
      handler.post {
        if (g !== gatt) return@post
        if (status == BluetoothGatt.GATT_SUCCESS) mtu = newMtu
        discoverServicesOnce(g)
      }
    }

    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
      handler.post {
        if (g !== gatt || connectPromise == null) return@post
        if (status != BluetoothGatt.GATT_SUCCESS) return@post failConnect("connect-failed", "service discovery failed ($status)")
        selectUart(g)
      }
    }

    override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      handler.post {
        if (g !== gatt || descriptor.characteristic.uuid != notifyChar?.uuid || connectPromise == null) return@post
        if (status != BluetoothGatt.GATT_SUCCESS) return@post failConnect("connect-failed", "subscribe failed ($status)")
        succeedBle()
      }
    }

    override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      handler.post {
        if (g !== gatt) return@post
        bleWriting = false
        pumpBle()
      }
    }

    // API 33+ delivers the value as a parameter; older Android only the deprecated variant below.
    override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      val data = value.copyOf()
      handler.post { if (g === gatt && characteristic.uuid == notifyChar?.uuid) onBytes(data) }
    }

    @Deprecated("Used before Android 13")
    override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      @Suppress("DEPRECATION") val data = characteristic.value?.copyOf() ?: return
      handler.post { if (g === gatt && characteristic.uuid == notifyChar?.uuid) onBytes(data) }
    }
  }

  private fun discoverServicesOnce(g: BluetoothGatt) {
    if (servicesRequested || connectPromise == null) return
    servicesRequested = true
    if (!g.discoverServices()) failConnect("connect-failed", "could not start service discovery")
  }

  private fun properties(c: BluetoothGattCharacteristic): Set<String> {
    val p = c.properties
    val out = mutableSetOf<String>()
    if (p and BluetoothGattCharacteristic.PROPERTY_READ != 0) out += "read"
    if (p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) out += "write"
    if (p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) out += "writeWithoutResponse"
    if (p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) out += "notify"
    if (p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) out += "indicate"
    return out
  }

  /** UART selection lives in LinkLogic (unit-tested); this maps Android GATT objects in and out. */
  private fun selectUart(g: BluetoothGatt) {
    val request = connectRequest ?: return
    val services = g.services
    val infos = services.map { s -> ServiceInfo(s.uuid.toString(), s.characteristics.map { CharacteristicInfo(it.uuid.toString(), properties(it)) }) }
    gattDump = services.map { s ->
      mapOf("uuid" to s.uuid.toString().uppercase(), "characteristics" to s.characteristics.map { c ->
        mapOf("uuid" to c.uuid.toString().uppercase(), "properties" to properties(c).toList())
      })
    }.toMutableList()
    val sel = LinkLogic.selectUart(infos, request.profiles, request.preferred)
    if (sel == null) {
      // JS parses the dump from the message (iOS does the same) to extend the catalog.
      return failConnect("no-uart-service", org.json.JSONArray(gattDump.map { org.json.JSONObject(it) }).toString())
    }
    val service = services[sel.service]
    val n = service.characteristics[sel.notify]
    val w = service.characteristics[sel.write]
    notifyChar = n
    writeChar = w
    selected = mapOf("profileId" to sel.profileId, "service" to service.uuid.toString().uppercase(), "notify" to n.uuid.toString().uppercase(), "write" to w.uuid.toString().uppercase())
    g.setCharacteristicNotification(n, true)
    val cccd = n.getDescriptor(CCCD)
    if (cccd == null) return succeedBle() // some adapters notify without a descriptor
    val value = if (n.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) {
      BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
    } else {
      BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
    }
    val started = if (Build.VERSION.SDK_INT >= 33) {
      g.writeDescriptor(cccd, value) == BluetoothGatt.GATT_SUCCESS
    } else {
      @Suppress("DEPRECATION") run {
        cccd.value = value
        g.writeDescriptor(cccd)
      }
    }
    if (!started) failConnect("connect-failed", "could not subscribe to the adapter")
  }

  private fun succeedBle() {
    succeedConnect(mapOf("gatt" to selected, "gattDump" to gattDump, "deviceInfo" to mapOf("name" to (gatt?.device?.let { safeName(it) } ?: ""), "mtu" to mtu.toString())))
  }

  private fun pumpBle() {
    val g = gatt ?: return
    val w = writeChar ?: return
    if (bleWriting || bleChunks.isEmpty()) return
    val chunk = bleChunks.removeFirst()
    val p = w.properties
    // Same preference as iOS: with response when the characteristic supports it.
    val type = if (p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) {
      BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
    } else {
      BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
    }
    bleWriting = true
    val ok = if (Build.VERSION.SDK_INT >= 33) {
      g.writeCharacteristic(w, chunk, type) == BluetoothGatt.GATT_SUCCESS
    } else {
      @Suppress("DEPRECATION") run {
        w.writeType = type
        w.value = chunk
        g.writeCharacteristic(w)
      }
    }
    if (!ok) {
      // The stack is busy: put the chunk back and try again shortly.
      bleWriting = false
      bleChunks.addFirst(chunk)
      handler.postDelayed({ pumpBle() }, 20)
    }
  }

  // --- Classic Bluetooth SPP ----------------------------------------------------------------------------------------

  private fun connectSpp(request: ConnectRequest, generation: Int) {
    val a = adapter
    if (a == null || !a.isEnabled) return failConnect("bluetooth-off", "Bluetooth is off")
    if (!hasConnectPermission()) return failConnect("bluetooth-unauthorized", "Bluetooth permission denied")
    val mac = LinkLogic.parseSppId(request.id) ?: return failConnect("device-not-found", "invalid adapter id")
    val device = try {
      a.getRemoteDevice(mac)
    } catch (e: IllegalArgumentException) {
      return failConnect("device-not-found", "adapter not found")
    }
    kind = Kind.SPP
    io.execute {
      fun cancelled() = generation != connectGeneration
      // 1. Pair first when needed: the system shows the PIN dialog (most adapters: 1234 or 0000).
      if (device.bondState == BluetoothDevice.BOND_NONE) {
        val latch = CountDownLatch(1)
        synchronized(bondWaiters) { bondWaiters[mac] = latch }
        device.createBond()
        latch.await(90, TimeUnit.SECONDS)
        synchronized(bondWaiters) { bondWaiters.remove(mac) }
        if (device.bondState != BluetoothDevice.BOND_BONDED) {
          if (!cancelled()) handler.post { failConnect("bond-failed", "pairing was not completed") }
          return@execute
        }
      }
      a.cancelDiscovery()
      // 2. Connect: secure RFCOMM first, then the insecure one, then the hidden channel-1 socket many clones need.
      while (!cancelled()) {
        var opened: BluetoothSocket? = null
        var how = ""
        val attempts = listOf<Pair<String, () -> BluetoothSocket>>(
          "secure" to { device.createRfcommSocketToServiceRecord(SPP_UUID) },
          "insecure" to { device.createInsecureRfcommSocketToServiceRecord(SPP_UUID) },
          "channel1" to {
            device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType).invoke(device, 1) as BluetoothSocket
          },
        )
        for ((name, create) in attempts) {
          if (cancelled()) return@execute
          try {
            val s = create()
            s.connect()
            opened = s
            how = name
            break
          } catch (e: Exception) {
            Log.w(TAG, "spp $name connect failed: ${e.message}")
          }
        }
        if (opened != null) {
          val s = opened
          val method = how
          handler.post {
            if (cancelled() || connectPromise == null) {
              runCatching { s.close() }
              return@post
            }
            socket = s
            sppOut = s.outputStream
            startReader(s, s.inputStream)
            succeedConnect(mapOf("protocol" to "spp", "deviceInfo" to mapOf("name" to (safeName(device) ?: ""), "socket" to method)))
          }
          return@execute
        }
        // A reconnect (timeoutMs 0) keeps trying until the adapter is back or the connect is cancelled.
        if (request.timeoutMs != 0L) {
          handler.post { if (!cancelled()) failConnect("connect-failed", "could not open a serial connection to the adapter") }
          return@execute
        }
        Thread.sleep(SPP_RETRY_MS)
      }
    }
  }

  private fun startReader(s: BluetoothSocket, input: InputStream) {
    io.execute {
      val buf = ByteArray(1024)
      try {
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          if (n > 0) {
            val data = buf.copyOf(n)
            handler.post { if (socket === s) onBytes(data) }
          }
        }
      } catch (e: Exception) {
        // closed by us or the adapter went away
      }
      handler.post { if (socket === s) closeLink("adapter disconnected", true) }
    }
  }

  // --- Transactions -------------------------------------------------------------------------------------------------

  private fun write(data: ByteArray) {
    when (kind) {
      Kind.BLE -> {
        bleChunks.addAll(LinkLogic.chunk(data, LinkLogic.bleChunkLimit(mtu)))
        pumpBle()
      }
      Kind.SPP -> {
        val out = sppOut ?: return
        val s = socket
        sppWriter.execute {
          try {
            out.write(data)
            out.flush()
          } catch (e: Exception) {
            handler.post { if (socket === s) closeLink("adapter write failed", true) }
          }
        }
      }
      Kind.NONE -> {}
    }
  }

  fun transact(command: String, timeoutMs: Double, promise: Promise) {
    handler.post {
      if (!linkUp) return@post promise.reject("not-connected", "no adapter link", null)
      if (pending != null) return@post promise.reject("busy", "a command is already in flight", null)
      framer.reset()
      pendingSeq++
      val id = pendingSeq
      val p = Pending(id, promise, nowUs())
      pending = p
      handler.postDelayed({
        val cur = pending
        if (cur == null || cur.id != id) return@postDelayed
        pending = null
        val raw = framer.text
        framer.reset()
        val result = mutableMapOf<String, Any?>("raw" to raw, "status" to "timeout", "txUs" to cur.txUs, "rxUs" to nowUs())
        cur.rxFirstUs?.let { result["rxFirstUs"] = it }
        cur.promise.resolve(result)
      }, maxOf(50L, timeoutMs.toLong()))
      write((command + "\r").toByteArray())
    }
  }

  fun writeRaw(text: String, promise: Promise) {
    handler.post {
      if (!linkUp) return@post promise.reject("not-connected", "no adapter link", null)
      write(text.toByteArray())
      promise.resolve(null)
    }
  }

  /** Runs on the handler thread. */
  private fun onBytes(data: ByteArray) {
    val now = nowUs()
    val clean = PromptFramer.clean(data)
    if (clean.isEmpty()) return
    val p = pending
    if (p == null) {
      emit("onUnsolicited", mapOf("text" to String(clean, Charsets.UTF_8), "rxUs" to now))
      return
    }
    if (p.rxFirstUs == null) p.rxFirstUs = now
    val raw = framer.append(clean) ?: return
    pending = null
    val result = mutableMapOf<String, Any?>("raw" to raw, "status" to "ok", "txUs" to p.txUs, "rxUs" to now)
    p.rxFirstUs?.let { result["rxFirstUs"] = it }
    p.promise.resolve(result)
  }

  fun shutdown() {
    handler.post {
      closeLink("module destroyed", false)
      stopScanLocked()
      if (receiversRegistered) {
        runCatching { context.unregisterReceiver(receiver) }
        receiversRegistered = false
      }
      io.shutdownNow()
      sppWriter.shutdownNow()
      thread.quitSafely()
    }
  }
}
