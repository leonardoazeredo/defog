package codes.madera.crossfog.watchlink

import java.security.KeyStoreException
import java.security.UnrecoverableKeyException
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

class KekReadTest {
  private val kek = SecretKeySpec(ByteArray(32), "AES")
  private var pauses = 0
  private val pause: () -> Unit = { pauses++ }

  @Test
  fun aKeyReadOnTheFirstTryIsReturnedWithoutAPause() {
    var reads = 0
    assertSame(kek, readKekOrLost(pause) { reads++; kek })
    assertEquals(1, reads)
    assertEquals(0, pauses)
  }

  @Test
  fun aTransientUnrecoverableKeyExceptionThatSucceedsOnRetryIsNotLost() {
    var reads = 0
    val got = readKekOrLost(pause) {
      reads++
      if (reads == 1) throw UnrecoverableKeyException("device locked")
      kek
    }
    assertSame(kek, got)
    assertEquals(2, reads)
    assertEquals(1, pauses)
  }

  @Test
  fun anUnrecoverableKeyExceptionOnTheRetryTooIsALostKey() {
    var reads = 0
    assertThrows(KeyLostException::class.java) {
      readKekOrLost(pause) {
        reads++
        throw UnrecoverableKeyException("key damaged")
      }
    }
    assertEquals(2, reads)
  }

  @Test
  fun aMissingKeyIsLostWithoutARetry() {
    var reads = 0
    assertThrows(KeyLostException::class.java) { readKekOrLost(pause) { reads++; null } }
    assertEquals(1, reads)
    assertEquals(0, pauses)
  }

  @Test
  fun aMissingKeyOnTheRetryIsALostKey() {
    var reads = 0
    assertThrows(KeyLostException::class.java) {
      readKekOrLost(pause) {
        reads++
        if (reads == 1) throw UnrecoverableKeyException("device locked")
        null
      }
    }
  }

  @Test
  fun anyOtherFailurePropagatesUnchangedWithoutARetry() {
    val busy = KeyStoreException("keystore busy")
    var reads = 0
    val thrown = assertThrows(KeyStoreException::class.java) {
      readKekOrLost(pause) { reads++; throw busy }
    }
    assertSame(busy, thrown)
    assertEquals(1, reads)
  }
}
