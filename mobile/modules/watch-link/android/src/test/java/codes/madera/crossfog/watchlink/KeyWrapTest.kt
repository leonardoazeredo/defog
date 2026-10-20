package codes.madera.crossfog.watchlink

import java.security.GeneralSecurityException
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class KeyWrapTest {
  private val kek = SecretKeySpec(ByteArray(32), "AES")
  private val dek = ByteArray(32) { it.toByte() }

  @Test
  fun wrapThenUnwrapReturnsTheKey() {
    val wrap = KeyWrap(kek, "alias")
    assertArrayEquals(dek, wrap.unwrap(wrap.wrap(dek)))
  }

  @Test
  fun twoWrapsOfTheSameKeyDiffer() {
    val wrap = KeyWrap(kek, "alias")
    assertFalse(wrap.wrap(dek).contentEquals(wrap.wrap(dek)))
  }

  @Test
  fun aFlippedByteFailsToUnwrap() {
    val wrap = KeyWrap(kek, "alias")
    val blob = wrap.wrap(dek)
    for (i in blob.indices) {
      val damaged = blob.copyOf().also { it[i] = (it[i].toInt() xor 1).toByte() }
      assertThrows("byte $i", GeneralSecurityException::class.java) { wrap.unwrap(damaged) }
    }
  }

  @Test
  fun aBlobWrappedForAnotherAliasFailsToUnwrap() {
    val blob = KeyWrap(kek, "alias").wrap(dek)
    assertThrows(GeneralSecurityException::class.java) { KeyWrap(kek, "other").unwrap(blob) }
  }

  @Test
  fun aBlobShorterThanIvAndTagFailsToUnwrap() {
    assertThrows(GeneralSecurityException::class.java) { KeyWrap(kek, "alias").unwrap(ByteArray(5)) }
  }

  @Test
  fun theBlobIsATwelveByteIvThenCiphertextAndTag() {
    assertEquals(12 + dek.size + 16, KeyWrap(kek, "alias").wrap(dek).size)
  }
}
