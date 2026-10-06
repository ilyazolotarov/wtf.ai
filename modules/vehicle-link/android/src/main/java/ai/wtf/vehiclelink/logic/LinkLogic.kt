package ai.wtf.vehiclelink.logic

// Pure transport logic for the Android VehicleLinkModule (docs/ANDROID-SPEC.md §3 C), ported line for line from
// modules/vehicle-link/ios/Logic/LinkLogic.swift. No android.* imports: unit-tested on a plain JVM
// (native-tests-android/), with the same vectors as the Swift tests.

data class CharacteristicInfo(
  val uuid: String,
  /** "read", "write", "writeWithoutResponse", "notify", "indicate" */
  val properties: Set<String>,
) {
  val canNotify: Boolean get() = "notify" in properties || "indicate" in properties
  val canWrite: Boolean get() = "write" in properties || "writeWithoutResponse" in properties
}

data class ServiceInfo(val uuid: String, val characteristics: List<CharacteristicInfo>)

data class ProfileSpec(val id: String, val service: String, val notify: String?, val write: String?)

/** Indices into the service list / characteristic lists passed to `selectUart`. */
data class UartSelection(val profileId: String, val service: Int, val notify: Int, val write: Int)

object LinkLogic {
  const val BLUETOOTH_BASE_SUFFIX = "-0000-1000-8000-00805F9B34FB"
  val IGNORED_SERVICES = setOf("1800", "1801", "180A", "180F", "FEF5")

  private val HEX_SHORT = Regex("^[0-9a-fA-F]{4}$|^[0-9a-fA-F]{8}$")
  private val FULL_UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
  private val MAC = Regex("^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")

  /** Upper case; SIG base UUIDs ("0000FFF0-0000-1000-8000-00805F9B34FB") become the short form ("FFF0"). */
  fun normalizeUUID(uuid: String): String {
    val u = uuid.trim().uppercase()
    if (u.length == 36 && u.startsWith("0000") && u.endsWith(BLUETOOTH_BASE_SUFFIX)) return u.substring(4, 8)
    return u
  }

  /** 16/32-bit hex or a full UUID. */
  fun isValidUUIDString(s: String): Boolean {
    val t = s.trim()
    return HEX_SHORT.matches(t) || FULL_UUID.matches(t)
  }

  /** Short UUIDs expand onto the Bluetooth base UUID, as Android's `UUID.fromString` needs the full form. */
  fun fullUUID(s: String): String {
    val t = s.trim().uppercase()
    return when (t.length) {
      4 -> "0000$t$BLUETOOTH_BASE_SUFFIX"
      8 -> "$t$BLUETOOTH_BASE_SUFFIX"
      else -> t
    }
  }

  /** Bluetooth SIG GATT services live in 0x1800–0x18FF (18F0 is Vgate's, not SIG). */
  fun isSigService(uuid: String): Boolean {
    val u = normalizeUUID(uuid)
    return u.length == 4 && u.startsWith("18") && u != "18F0"
  }

  /**
   * Pick the UART (VEHICLE-LINK-SPEC §8.2): remembered pair, then catalog profiles in order,
   * then a non-SIG service with exactly one notify and one write characteristic.
   */
  fun selectUart(services: List<ServiceInfo>, profiles: List<ProfileSpec>, preferred: List<String>?): UartSelection? {
    fun find(chars: List<CharacteristicInfo>, uuid: String?, fallback: (CharacteristicInfo) -> Boolean): Int? {
      if (uuid != null) {
        val target = normalizeUUID(uuid)
        return chars.indexOfFirst { normalizeUUID(it.uuid) == target }.takeIf { it >= 0 }
      }
      return chars.indexOfFirst(fallback).takeIf { it >= 0 }
    }

    fun pick(serviceUuid: String, notify: String?, write: String?, id: String): UartSelection? {
      val target = normalizeUUID(serviceUuid)
      val s = services.indexOfFirst { normalizeUUID(it.uuid) == target }
      if (s < 0) return null
      val chars = services[s].characteristics
      val n = find(chars, notify) { it.canNotify } ?: return null
      val w = find(chars, write) { it.canWrite } ?: return null
      if (!(chars[n].canNotify && chars[w].canWrite)) return null
      return UartSelection(id, s, n, w)
    }

    if (preferred != null && preferred.size == 3) {
      pick(preferred[0], preferred[1], preferred[2], "remembered")?.let { return it }
    }
    for (profile in profiles) {
      pick(profile.service, profile.notify, profile.write, profile.id)?.let { return it }
    }
    for ((s, service) in services.withIndex()) {
      val id = normalizeUUID(service.uuid)
      if (id in IGNORED_SERVICES || isSigService(id)) continue
      val notifies = service.characteristics.indices.filter { service.characteristics[it].canNotify }
      val writes = service.characteristics.indices.filter { service.characteristics[it].canWrite }
      if (notifies.size == 1 && writes.size == 1) return UartSelection("heuristic", s, notifies[0], writes[0])
    }
    return null
  }

  /**
   * Largest single write: the negotiated ATT MTU minus the 3-byte header, never below the 20-byte minimum
   * (the default MTU 23 − 3). Android reports the real MTU for both write types, unlike iOS.
   */
  fun bleChunkLimit(mtu: Int): Int = maxOf(20, mtu - 3)

  /** Split a write into BLE-sized chunks (never smaller than the 20-byte ATT minimum). */
  fun chunk(data: ByteArray, size: Int): List<ByteArray> {
    val n = maxOf(20, size)
    val out = mutableListOf<ByteArray>()
    var offset = 0
    while (offset < data.size) {
      val end = minOf(offset + n, data.size)
      out.add(data.copyOfRange(offset, end))
      offset = end
    }
    return out
  }

  /** "spp:<MAC>" to the MAC; null for anything else. */
  fun parseSppId(id: String): String? {
    if (!id.startsWith("spp:")) return null
    val mac = id.removePrefix("spp:")
    return mac.takeIf { MAC.matches(it) }?.uppercase()
  }

  fun sppId(mac: String): String = "spp:" + mac.uppercase()

  /** A BLE peripheral id is the bare MAC address. */
  fun parseBleId(id: String): String? = id.takeIf { MAC.matches(it) }?.uppercase()
}

/** Accumulates adapter bytes until the ELM `>` prompt (VEHICLE-LINK-SPEC §5.3). */
class PromptFramer {
  private var buffer = ByteArray(0)

  val text: String get() = String(buffer, Charsets.UTF_8)
  val isEmpty: Boolean get() = buffer.isEmpty()

  fun reset() {
    buffer = ByteArray(0)
  }

  companion object {
    /** Clone adapters may send NULs; drop them. */
    fun clean(data: ByteArray): ByteArray = data.filter { it != 0.toByte() }.toByteArray()
  }

  /** Appends cleaned bytes; returns the full response text once `>` has arrived (and resets). */
  fun append(data: ByteArray): String? {
    buffer += clean(data)
    if (buffer.none { it == 0x3E.toByte() }) return null
    val raw = text
    buffer = ByteArray(0)
    return raw
  }
}
