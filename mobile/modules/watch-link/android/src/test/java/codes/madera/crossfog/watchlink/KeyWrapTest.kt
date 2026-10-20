package codes.madera.crossfog.watchlink

import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
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

  @Test
  fun aBlobOneByteUnderIvAndTagFailsOnSizeAndExactlyThatSizeFailsOnTheTag() {
    val wrap = KeyWrap(kek, "alias")
    assertThrows(GeneralSecurityException::class.java) { wrap.unwrap(ByteArray(27)) }
    assertThrows(GeneralSecurityException::class.java) { wrap.unwrap(ByteArray(28)) }
  }

  @Test
  fun theBlobLayoutIsIvThenCiphertextUnderTheAlias() {
    val blob = KeyWrap(kek, "alias").wrap(dek)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, kek, GCMParameterSpec(128, blob, 0, 12))
    cipher.updateAAD("alias".toByteArray(Charsets.UTF_8))
    assertArrayEquals(dek, cipher.doFinal(blob, 12, blob.size - 12))
  }

  @Test
  fun hexKeepsLeadingZerosAndDoesNotSignExtend() {
    assertEquals("000f7f80ff", byteArrayOf(0x00, 0x0f, 0x7f, 0x80.toByte(), 0xff.toByte()).toHex())
  }
}
