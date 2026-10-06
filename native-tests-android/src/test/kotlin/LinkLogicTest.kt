import ai.wtf.vehiclelink.logic.CharacteristicInfo
import ai.wtf.vehiclelink.logic.LinkLogic
import ai.wtf.vehiclelink.logic.ProfileSpec
import ai.wtf.vehiclelink.logic.PromptFramer
import ai.wtf.vehiclelink.logic.ServiceInfo
import ai.wtf.vehiclelink.logic.UartSelection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Same vectors as native-tests/VehicleLinkLogicTests/LinkLogicTests.swift, so iOS and Android agree.

// Mirrors the TS catalog (src/obd/catalog.ts GATT_PROFILES) that JS passes to native.
private val profiles = listOf(
  ProfileSpec("fff0", "FFF0", "FFF1", "FFF2"),
  ProfileSpec("ffe0", "FFE0", "FFE1", "FFE1"),
  ProfileSpec("vgate", "18F0", "2AF0", "2AF1"),
  ProfileSpec("e781", "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2", "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F", "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F"),
  ProfileSpec("issc", "49535343-FE7D-4AE5-8FA9-9FAFD205E455", null, null),
  ProfileSpec("nus", "6E400001-B5A3-F393-E0A9-E50E24DCCA9E", "6E400003-B5A3-F393-E0A9-E50E24DCCA9E", "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"),
)

private fun char(uuid: String, vararg props: String) = CharacteristicInfo(uuid, props.toSet())

private val deviceInfo = ServiceInfo("180A", listOf(char("2A29", "read")))

private fun select(services: List<ServiceInfo>, preferred: List<String>? = null) =
  LinkLogic.selectUart(services, profiles, preferred)

class UuidTest {
  @Test
  fun normalizesBaseUuidsToShortForm() {
    assertEquals("FFF1", LinkLogic.normalizeUUID("0000fff1-0000-1000-8000-00805f9b34fb"))
    assertEquals("FFF0", LinkLogic.normalizeUUID(" fff0 "))
    assertEquals("E7810A71-73AE-499D-8C15-FAA9AEF0C3F2", LinkLogic.normalizeUUID("e7810a71-73ae-499d-8c15-faa9aef0c3f2"))
  }

  @Test
  fun validUuidStrings() {
    assertTrue(LinkLogic.isValidUUIDString("FFF0"))
    assertTrue(LinkLogic.isValidUUIDString("0000fff0"))
    assertTrue(LinkLogic.isValidUUIDString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E"))
    assertFalse(LinkLogic.isValidUUIDString("FFF"))
    assertFalse(LinkLogic.isValidUUIDString("XYZ0"))
    assertFalse(LinkLogic.isValidUUIDString(""))
    assertFalse(LinkLogic.isValidUUIDString("6E400001-B5A3-F393-E0A9"))
  }

  @Test
  fun sigServices() {
    assertTrue(LinkLogic.isSigService("1812"))
    assertTrue(LinkLogic.isSigService("0000180A-0000-1000-8000-00805F9B34FB"))
    assertFalse(LinkLogic.isSigService("18F0"))
    assertFalse(LinkLogic.isSigService("FFF0"))
  }

  @Test
  fun shortUuidsExpandOntoTheBaseUuid() {
    assertEquals("0000FFF0-0000-1000-8000-00805F9B34FB", LinkLogic.fullUUID("fff0"))
    assertEquals("0000FFF0-0000-1000-8000-00805F9B34FB", LinkLogic.fullUUID("0000fff0"))
    assertEquals("6E400001-B5A3-F393-E0A9-E50E24DCCA9E", LinkLogic.fullUUID("6e400001-b5a3-f393-e0a9-e50e24dcca9e"))
  }
}

class UartSelectionTest {
  @Test
  fun obdlinkCxLayout() {
    val services = listOf(
      deviceInfo,
      ServiceInfo("FFF0", listOf(char("FFF1", "notify"), char("FFF2", "write", "writeWithoutResponse"))),
      ServiceInfo("FEF5", listOf(char("8082CAA8-41A6-4021-91C6-56F9B954CC34", "read", "write"))),
    )
    assertEquals(UartSelection("fff0", 1, 0, 1), select(services))
  }

  @Test
  fun hm10SingleCharacteristic() {
    val services = listOf(ServiceInfo("FFE0", listOf(char("FFE1", "notify", "writeWithoutResponse", "read"))))
    assertEquals(UartSelection("ffe0", 0, 0, 0), select(services))
  }

  @Test
  fun longFormUuidsFromAndroidMatchShortProfiles() {
    val services = listOf(
      ServiceInfo(
        "000018F0-0000-1000-8000-00805F9B34FB",
        listOf(char("00002AF1-0000-1000-8000-00805F9B34FB", "write"), char("00002AF0-0000-1000-8000-00805F9B34FB", "notify")),
      ),
    )
    assertEquals(UartSelection("vgate", 0, 1, 0), select(services))
  }

  @Test
  fun isscPicksByProperties() {
    val services = listOf(
      ServiceInfo(
        "49535343-FE7D-4AE5-8FA9-9FAFD205E455",
        listOf(
          char("49535343-6DAA-4D02-ABF6-19569ACA69FE", "read"),
          char("49535343-1E4D-4BD9-BA61-23C647249616", "notify"),
          char("49535343-8841-43F4-A8D4-ECBE34729BB3", "writeWithoutResponse"),
        ),
      ),
    )
    assertEquals(UartSelection("issc", 0, 1, 2), select(services))
  }

  @Test
  fun catalogOrderWinsWhenSeveralProfilesExist() {
    val services = listOf(
      ServiceInfo("49535343-FE7D-4AE5-8FA9-9FAFD205E455", listOf(char("A1", "notify"), char("A2", "write"))),
      ServiceInfo("FFF0", listOf(char("FFF1", "notify"), char("FFF2", "write"))),
    )
    assertEquals("fff0", select(services)?.profileId)
  }

  @Test
  fun rememberedPairWins() {
    val services = listOf(
      ServiceInfo("FFF0", listOf(char("FFF1", "notify"), char("FFF2", "write"))),
      ServiceInfo("ABCD", listOf(char("AB01", "indicate"), char("AB02", "write"))),
    )
    assertEquals(UartSelection("remembered", 1, 0, 1), select(services, listOf("ABCD", "AB01", "AB02")))
  }

  @Test
  fun staleRememberedPairFallsBackToCatalog() {
    val services = listOf(ServiceInfo("FFF0", listOf(char("FFF1", "notify"), char("FFF2", "write"))))
    assertEquals("fff0", select(services, listOf("ABCD", "AB01", "AB02"))?.profileId)
  }

  @Test
  fun heuristicForUnknownVendorServiceSkipsSigAndAmbiguous() {
    val services = listOf(
      ServiceInfo("1812", listOf(char("2A4D", "notify", "write"))),
      ServiceInfo("12345678-0000-0000-0000-000000000002", listOf(char("B1", "notify"), char("B2", "notify"), char("B3", "write"))),
      ServiceInfo("12345678-0000-0000-0000-000000000001", listOf(char("A1", "notify"), char("A2", "read"), char("A3", "write"))),
    )
    assertEquals(UartSelection("heuristic", 2, 0, 2), select(services))
  }

  @Test
  fun profileWithWrongPropertiesIsRejected() {
    // FFF1 does not notify, so the fff0 profile cannot be used; no other candidate.
    val services = listOf(ServiceInfo("FFF0", listOf(char("FFF1", "read"), char("FFF2", "write"))))
    assertNull(select(services))
  }

  @Test
  fun noUartOnHeadphones() {
    val services = listOf(
      deviceInfo,
      ServiceInfo("180F", listOf(char("2A19", "read", "notify"))),
      ServiceInfo("1800", listOf(char("2A00", "read"))),
    )
    assertNull(select(services))
  }
}

class ChunkAndIdTest {
  @Test
  fun chunksRespectMtuButNeverBelow20() {
    val data = ByteArray(45) { 0x41 }
    assertEquals(listOf(20, 20, 5), LinkLogic.chunk(data, 20).map { it.size })
    assertEquals(listOf(45), LinkLogic.chunk(data, 182).map { it.size })
    assertEquals(listOf(20, 20, 5), LinkLogic.chunk(data, 0).map { it.size })
    assertEquals(emptyList(), LinkLogic.chunk(ByteArray(0), 20))
    assertTrue(data.contentEquals(LinkLogic.chunk(data, 20).reduce { a, b -> a + b }))
  }

  @Test
  fun chunkLimitIsTheNegotiatedMtuMinusHeader() {
    assertEquals(244, LinkLogic.bleChunkLimit(247))
    assertEquals(20, LinkLogic.bleChunkLimit(23))
    assertEquals(20, LinkLogic.bleChunkLimit(0))
    val command = ByteArray(300) { 0x41 }
    assertEquals(listOf(182, 118), LinkLogic.chunk(command, LinkLogic.bleChunkLimit(185)).map { it.size })
  }

  @Test
  fun sppAndBleIds() {
    assertEquals("AA:BB:CC:DD:EE:FF", LinkLogic.parseSppId("spp:aa:bb:cc:dd:ee:ff"))
    assertEquals("spp:AA:BB:CC:DD:EE:FF", LinkLogic.sppId("aa:bb:cc:dd:ee:ff"))
    assertNull(LinkLogic.parseSppId("spp:not-a-mac"))
    assertNull(LinkLogic.parseSppId("AA:BB:CC:DD:EE:FF"))
    assertNull(LinkLogic.parseSppId("mfi:ABC:com.obdlink"))
    assertEquals("AA:BB:CC:DD:EE:FF", LinkLogic.parseBleId("aa:bb:cc:dd:ee:ff"))
    assertNull(LinkLogic.parseBleId("spp:AA:BB:CC:DD:EE:FF"))
    assertNull(LinkLogic.parseBleId("emulator:genuine"))
  }
}

class PromptFramerTest {
  @Test
  fun completesOnPromptAcrossChunks() {
    val f = PromptFramer()
    assertNull(f.append("41 0D".toByteArray()))
    assertNull(f.append(" 3C\r".toByteArray()))
    assertEquals("41 0D 3C\r\r>", f.append("\r>".toByteArray()))
    assertTrue(f.isEmpty)
  }

  @Test
  fun dropsNulBytesFromClones() {
    val f = PromptFramer()
    assertEquals("OK\r>", f.append(byteArrayOf(0x00, 0x4F, 0x4B, 0x00, 0x0D, 0x3E)))
  }

  @Test
  fun textShowsPartialResponseForTimeouts() {
    val f = PromptFramer()
    f.append("SEARCHING...\r".toByteArray())
    assertEquals("SEARCHING...\r", f.text)
    f.reset()
    assertTrue(f.isEmpty)
  }

  @Test
  fun invalidUtf8DoesNotCrash() {
    val f = PromptFramer()
    assertNotNull(f.append(byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 0x3E)))
  }
}
