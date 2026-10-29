package com.atonal440.alongside

import com.atonal440.alongside.domain.QuickAddParser
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

/**
 * Runs the spec table (`src/test/resources/quickadd-parse-cases.json`): each row is an input, the clock it is parsed
 * at, and the expected date, time, repeat and leftover text. The lab (`scripts/llm-lab`) reads the same file.
 */
class QuickAddParserTest {
    private val fixture = Json.parseToJsonElement(checkNotNull(javaClass.classLoader.getResource("quickadd-parse-cases.json")).readText()).jsonObject
    private val defaultNow = LocalDateTime.parse(fixture.getValue("now").jsonPrimitive.content)

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    @Test fun `every shared case parses to the expected date, time, recurrence and rest`() {
        val cases = fixture.getValue("cases").jsonArray
        assertTrue("fixture should not be empty", cases.size > 100)
        val failures = cases.mapNotNull { element ->
            val c = element.jsonObject
            val now = c.str("now")?.let(LocalDateTime::parse) ?: defaultNow
            val p = QuickAddParser.parse(c.getValue("in").jsonPrimitive.content, now)
            val actual = listOf(p.date?.toString(), p.time?.toString(), p.recurrence, p.rest)
            val expected = listOf(c.str("date"), c.str("time"), c.str("recurrence"), c.str("rest"))
            if (actual == expected) null else "${c.str("in")}  [now $now]\n    expected $expected\n    actual   $actual"
        }
        assertEquals("${failures.size} of ${cases.size} shared cases failed:\n" + failures.joinToString("\n"), 0, failures.size)
    }

    @Test fun `vague phrases are flagged approximate, precise ones are not`() {
        assertTrue(QuickAddParser.parse("lunch tomorrow morning", defaultNow).approx)
        assertEquals(false, QuickAddParser.parse("lunch tomorrow at 9am", defaultNow).approx)
        assertTrue(QuickAddParser.parse("call at 5", defaultNow).approx)
    }

    @Test fun `next means the following Monday-to-Sunday week and this is the upcoming one`() {
        val wed = LocalDateTime.parse("2026-10-28T10:00")
        fun date(s: String) = QuickAddParser.parse(s, wed).date?.toString()
        assertEquals("2026-11-06", date("book flights next friday"))
        assertEquals("2026-10-30", date("book flights this friday"))
        assertEquals("2026-10-30", date("book flights friday"))
        assertEquals("2026-11-04", date("book flights wednesday"))
    }
}
