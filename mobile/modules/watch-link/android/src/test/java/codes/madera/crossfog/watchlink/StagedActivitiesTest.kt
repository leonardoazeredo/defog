package codes.madera.crossfog.watchlink

import java.io.File
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class StagedActivitiesTest {
  @get:Rule val tmp = TemporaryFolder()

  private val sealing = SecretKeySpec(ByteArray(32) { 7 }, "AES")
  private val other = SecretKeySpec(ByteArray(32) { 9 }, "AES")
  private val a = "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0001"
  private val b = "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0002"
  private val dir get() = File(tmp.root, "staging")

  private fun store(key: SecretKeySpec = sealing) = StagingStore(dir, key, {})

  private fun offer(id: String) =
    """{"activityId":"$id","travelMode":"walk","encoderVersion":"1","gpx":"<gpx/>"}""".toByteArray()

  @Test
  fun readableOffersAreListedAndNothingIsUnreadable() {
    store().stage(a, offer(a))
    val staged = readStagedActivities(store())
    assertEquals(listOf(a), staged.readable.map { it.activityId })
    assertEquals(0, staged.unreadable)
  }

  // A lost staging alias means a new key: what was sealed under the old one must be counted, not
  // vanish, and stay on disk.
  @Test
  fun itemsSealedUnderALostKeyAreCountedAndKept() {
    store().stage(a, offer(a))
    store().stage(b, offer(b))
    val staged = readStagedActivities(store(other))
    assertEquals(emptyList<ActivityOffer>(), staged.readable)
    assertEquals(2, staged.unreadable)
    assertTrue(File(dir, "$a.bin").exists())
    assertTrue(File(dir, "$b.bin").exists())
  }

  @Test
  fun anItemThatDoesNotParseOrMatchItsNameIsCounted() {
    store().stage(a, "not json".toByteArray())
    store().stage(b, offer(a))
    val staged = readStagedActivities(store())
    assertEquals(emptyList<ActivityOffer>(), staged.readable)
    assertEquals(2, staged.unreadable)
  }

  @Test
  fun oneUnreadableItemDoesNotHideTheOthers() {
    store(other).stage(a, offer(a))
    store().stage(b, offer(b))
    val staged = readStagedActivities(store())
    assertEquals(listOf(b), staged.readable.map { it.activityId })
    assertEquals(1, staged.unreadable)
  }
}
