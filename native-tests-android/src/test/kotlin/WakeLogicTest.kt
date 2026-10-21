import ai.wtf.vehiclelink.logic.WakeLogic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WakeLogicTest {
  @Test
  fun onlyBleAdaptersAreOfferedByAddress() {
    assertEquals("AA:BB:CC:DD:EE:FF", WakeLogic.bleAddress("aa:bb:cc:dd:ee:ff"))
    assertNull(WakeLogic.bleAddress("spp:AA:BB:CC:DD:EE:FF"))
    assertNull(WakeLogic.bleAddress("emulator-1"))
    assertNull(WakeLogic.bleAddress(null))
  }

  @Test
  fun howTheDeviceAppeared() {
    assertEquals("ble in range", WakeLogic.how(true, false))
    assertEquals("bluetooth connected", WakeLogic.how(false, true))
    assertEquals("device appeared", WakeLogic.how(null, null))
  }

  @Test
  fun oneArrivalIsActedOnOnce() {
    val r = WakeLogic.Repeats(60_000)
    assertTrue(r.fresh(1_000))
    assertFalse(r.fresh(2_000)) // the same arrival through the other callback
    assertFalse(r.fresh(60_999))
    assertTrue(r.fresh(61_000))
  }
}
