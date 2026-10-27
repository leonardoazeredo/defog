package codes.madera.crossfog.watchlink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DatabaseKeyHexTest {
  @Test
  fun sixtyFourLowercaseHexDigitsAreThirtyTwoBytes() {
    val hex = "00ff" + "ab".repeat(30)
    val bytes = databaseKeyFromHex(hex)
    assertEquals(32, bytes.size)
    assertEquals(0xff.toByte(), bytes[1])
    assertEquals(hex, bytes.toHex())
  }

  @Test
  fun anythingElseIsRefused() {
    for (hex in listOf("", "ab".repeat(31), "ab".repeat(33), "AB".repeat(32), "zz" + "ab".repeat(31))) {
      assertThrows(IllegalArgumentException::class.java) { databaseKeyFromHex(hex) }
    }
  }
}
