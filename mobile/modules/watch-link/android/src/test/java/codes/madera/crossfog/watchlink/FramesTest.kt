package codes.madera.crossfog.watchlink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class FramesTest {
  private val id = "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0001"
  private val route = "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0002"

  private fun activity(
    activityId: String? = "\"$id\"",
    routeId: String? = "\"$route\"",
    travelMode: String? = "\"walk\"",
    encoderVersion: String? = "\"1\"",
    gpx: String? = "\"<gpx/>\"",
  ): ByteArray {
    val fields = listOf(
      "activityId" to activityId,
      "routeId" to routeId,
      "travelMode" to travelMode,
      "encoderVersion" to encoderVersion,
      "gpx" to gpx,
    ).filter { it.second != null }
    return fields.joinToString(",", "{", "}") { "\"${it.first}\":${it.second}" }.toByteArray()
  }

  @Test
  fun parsesAnActivityOffer() {
    val offer = Frames.parseActivityOffer(activity())
    assertEquals(ActivityOffer(id, route, "walk", "1", "<gpx/>"), offer)
  }

  @Test
  fun routeIdIsOptional() {
    assertNull(Frames.parseActivityOffer(activity(routeId = null)).routeId)
    assertNull(Frames.parseActivityOffer(activity(routeId = "null")).routeId)
  }

  @Test
  fun theSummaryCarriesNoTrackAndOmitsAMissingRouteId() {
    val summary = Frames.parseActivityOffer(activity(routeId = null)).summary()
    assertEquals(setOf("activityId", "travelMode", "encoderVersion"), summary.keys)
    assertFalse(summary.containsKey("gpx"))
  }

  @Test
  fun rejectsAnActivityOfferWithABadField() {
    val bad = listOf(
      activity(activityId = null),
      activity(activityId = "\"../x\""),
      activity(activityId = "5"),
      activity(routeId = "\"nope\""),
      activity(travelMode = "\"\""),
      activity(travelMode = "\"${"x".repeat(33)}\""),
      activity(encoderVersion = null),
      activity(encoderVersion = "\"${"x".repeat(65)}\""),
      activity(gpx = "\"\""),
      activity(gpx = "12"),
    )
    for (frame in bad) assertThrows(String(frame), FrameException::class.java) { Frames.parseActivityOffer(frame) }
  }

  @Test
  fun rejectsFramesThatAreNotJsonObjects() {
    for (text in listOf("", "[]", "null", "{", "plain")) {
      assertThrows(text, FrameException::class.java) { Frames.parseActivityOffer(text.toByteArray()) }
    }
  }

  @Test
  fun aParseFailureMessageHoldsNoPartOfTheInput() {
    val secret = "secret-track-content"
    val e = assertThrows(FrameException::class.java) {
      Frames.parseActivityOffer("{\"gpx\":\"$secret".toByteArray())
    }
    assertFalse(e.message!!.contains(secret))
    assertNull(e.cause)
  }

  @Test
  fun aFieldErrorMessageHoldsNoPartOfTheValue() {
    val e = assertThrows(FrameException::class.java) {
      Frames.parseActivityOffer(activity(activityId = "\"secret-value\""))
    }
    assertFalse(e.message!!.contains("secret-value"))
  }

  @Test
  fun rejectsAFrameOverTheLimitBeforeParsingIt() {
    val e = assertThrows(FrameException::class.java) {
      Frames.parseActivityOffer(ByteArray(MAX_FRAME_BYTES + 1))
    }
    assertEquals("frame is too large", e.message)
  }

  @Test
  fun acceptsAFrameExactlyAtTheLimit() {
    val head = activity(gpx = "\"\"").size
    val padded = activity(gpx = "\"${"a".repeat(MAX_FRAME_BYTES - head)}\"")
    assertEquals(MAX_FRAME_BYTES, padded.size)
    assertEquals(MAX_FRAME_BYTES - head, Frames.parseActivityOffer(padded).gpx.length)
  }

  @Test
  fun parsesARouteOffer() {
    val json = """{"routeId":"$route","name":"Route","travelMode":"run","createdAt":"2026-10-21T10:00:00Z","gpx":"<gpx/>"}"""
    assertEquals(RouteOffer(route, "Route", "run", "2026-10-21T10:00:00Z", "<gpx/>"), Frames.parseRouteOffer(json.toByteArray()))
  }

  @Test
  fun rejectsARouteOfferWithABadField() {
    val ok = mapOf("routeId" to "\"$route\"", "name" to "\"R\"", "travelMode" to "\"run\"", "createdAt" to "\"t\"", "gpx" to "\"g\"")
    for ((field, value) in listOf("routeId" to "\"../x\"", "name" to "\"\"", "travelMode" to "1", "createdAt" to "null", "gpx" to "\"\"")) {
      val json = (ok + (field to value)).entries.joinToString(",", "{", "}") { "\"${it.key}\":${it.value}" }
      assertThrows(field, FrameException::class.java) { Frames.parseRouteOffer(json.toByteArray()) }
    }
  }
}
