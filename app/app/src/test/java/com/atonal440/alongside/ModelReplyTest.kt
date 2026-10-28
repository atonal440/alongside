package com.atonal440.alongside

import com.atonal440.alongside.data.ai.ModelFields
import com.atonal440.alongside.data.ai.ModelReply
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ModelReplyTest {
    @Test fun `plain JSON object`() {
        assertEquals(
            ModelFields("Call mom", null, plan = false),
            ModelReply.parse("""{"title":"Call mom","notes":null,"task_type":"action"}"""),
        )
    }

    @Test fun `code fence and preamble are tolerated`() {
        val reply = "Sure! Here is the task:\n```json\n{\"title\": \"Plan trip to Japan\", \"notes\": \"flights first\", \"task_type\": \"plan\"}\n```"
        assertEquals(ModelFields("Plan trip to Japan", "flights first", plan = true), ModelReply.parse(reply))
    }

    @Test fun `notes spelled none are dropped`() {
        assertEquals(null, ModelReply.parse("""{"title":"x","notes":"none","task_type":"action"}""")?.notes)
        assertEquals(null, ModelReply.parse("""{"title":"x","notes":"","task_type":"action"}""")?.notes)
    }

    @Test fun `a missing or unknown task_type means action`() {
        val reply = "```json\n" + """{"title":"Organize band potluck","notes":"Create doodle poll"}""" + "\n```"
        assertEquals(ModelFields("Organize band potluck", "Create doodle poll", plan = false), ModelReply.parse(reply))
        assertEquals(false, ModelReply.parse("""{"title":"x","notes":null,"task_type":"someday"}""")?.plan)
    }

    @Test fun `unusable replies are rejected so the caller can retry`() {
        assertNull(ModelReply.parse("I cannot help with that."))
        assertNull(ModelReply.parse("""{"title":"","notes":null,"task_type":"action"}"""))
        assertNull(ModelReply.parse("""{"title":"x","notes":null"""))
    }
}
