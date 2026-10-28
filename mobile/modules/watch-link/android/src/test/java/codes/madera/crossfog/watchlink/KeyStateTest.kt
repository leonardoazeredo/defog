package codes.madera.crossfog.watchlink

import java.security.KeyStoreException
import java.security.UnrecoverableKeyException
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyStateTest {
  private val kek = SecretKeySpec(ByteArray(32), "AES")
  private val dek = ByteArray(32) { it.toByte() }

  @Test
  fun aKeyThatReadsIsExisting() {
    assertEquals(KeyState.EXISTING, stateOfPresentKey { })
  }

  @Test
  fun aKeyThatFailsForGoodIsUnreadable() {
    assertEquals(
      KeyState.UNREADABLE,
      stateOfPresentKey { throw KeyLostException("no match", permanent = true) },
    )
  }

  @Test
  fun anUnrecoverableKeyExceptionStillThereAfterTheRetryIsNotUnreadable() {
    val state = stateOfPresentKey {
      readKekOrLost({}) { throw UnrecoverableKeyException("key damaged") }
    }
    assertEquals(KeyState.EXISTING, state)
  }

  @Test
  fun aMissingKeystoreKeyBehindItsAliasIsNotUnreadable() {
    assertEquals(KeyState.EXISTING, stateOfPresentKey { readKekOrLost({}) { null } })
  }

  @Test
  fun anyOtherFailureIsNotUnreadable() {
    assertEquals(KeyState.EXISTING, stateOfPresentKey { throw KeyStoreException("keystore busy") })
  }

  @Test
  fun aFileThatUnwrapsGivesTheKey() {
    val blob = KeyWrap(kek, "alias").wrap(dek)
    assertArrayEquals(dek, unwrapDatabaseKey(kek, "alias", blob))
  }

  @Test
  fun aFileThatDoesNotMatchTheKeyFailsForGood() {
    val blob = KeyWrap(kek, "alias").wrap(dek)
    blob[blob.size - 1] = (blob[blob.size - 1].toInt() xor 1).toByte()
    val e = assertThrows(KeyLostException::class.java) { unwrapDatabaseKey(kek, "alias", blob) }
    assertTrue(e.permanent)
  }

  @Test
  fun aTruncatedFileFailsForGood() {
    val e = assertThrows(KeyLostException::class.java) {
      unwrapDatabaseKey(kek, "alias", ByteArray(10))
    }
    assertTrue(e.permanent)
  }

  @Test
  fun aKeyOfTheWrongLengthFailsForGood() {
    val blob = KeyWrap(kek, "alias").wrap(ByteArray(16))
    val e = assertThrows(KeyLostException::class.java) { unwrapDatabaseKey(kek, "alias", blob) }
    assertTrue(e.permanent)
  }

  @Test
  fun aLostKeystoreKeyIsNotPermanent() {
    val e = assertThrows(KeyLostException::class.java) { readKekOrLost({}) { null } }
    assertFalse(e.permanent)
  }
}
