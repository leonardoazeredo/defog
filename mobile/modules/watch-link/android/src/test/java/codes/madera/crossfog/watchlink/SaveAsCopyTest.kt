package codes.madera.crossfog.watchlink

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class SaveAsCopyTest {
  private fun bytes(n: Int) = ByteArray(n) { (it * 31 + 7).toByte() }

  @Test
  fun copiesAllBytesAcrossSeveralBuffers() {
    val data = bytes(2_500_000)
    val out = ByteArrayOutputStream()
    val r = SaveAs.copy(ByteArrayInputStream(data), out)
    assertEquals(data.size.toLong(), r.size)
    assertArrayEquals(data, out.toByteArray())
  }

  @Test
  fun reportsTheFirstSixteenBytes() {
    val data = bytes(100)
    val r = SaveAs.copy(ByteArrayInputStream(data), ByteArrayOutputStream())
    assertArrayEquals(data.copyOf(16), r.head)
  }

  @Test
  fun headIsShortForAShortFile() {
    val r = SaveAs.copy(ByteArrayInputStream(bytes(5)), ByteArrayOutputStream())
    assertEquals(5, r.head.size)
  }

  @Test
  fun anEmptyInputCopiesNothing() {
    val r = SaveAs.copy(ByteArrayInputStream(ByteArray(0)), ByteArrayOutputStream())
    assertEquals(0L, r.size)
    assertEquals(0, r.head.size)
  }

  @Test
  fun headIsCompleteWhenTheStreamDeliversInSmallReads() {
    val data = bytes(64)
    val trickle = object : InputStream() {
      private var pos = 0
      override fun read() = if (pos < data.size) data[pos++].toInt() and 0xff else -1
      override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (pos >= data.size) return -1
        val n = minOf(3, len, data.size - pos)
        data.copyInto(b, off, pos, pos + n)
        pos += n
        return n
      }
    }
    val r = SaveAs.copy(trickle, ByteArrayOutputStream())
    assertArrayEquals(data.copyOf(16), r.head)
  }

  @Test(expected = IOException::class)
  fun aFailingStreamPropagates() {
    val failing = object : InputStream() {
      override fun read() = throw IOException("boom")
    }
    SaveAs.copy(failing, ByteArrayOutputStream())
  }
}
