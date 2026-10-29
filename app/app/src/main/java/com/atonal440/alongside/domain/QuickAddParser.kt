package com.atonal440.alongside.domain

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

/**
 * Deterministic date, time and recurrence extraction for quick-add text, so the on-device model never
 * does calendar arithmetic. The cases in `app/app/src/test/resources/quickadd-parse-cases.json` are its spec: add a case
 * for every phrasing you fix.
 *
 * A table of regexes ([rules]) each claims a span and says what it means. Overlaps go to the longest span.
 * The claimed spans are cut out of the text, which leaves [Parsed.rest] for the model. Everything resolves
 * against the caller's local clock into wall-clock values (a local date, an optional local time); zones,
 * DST gaps and folds are left to whoever turns that into an instant.
 */
object QuickAddParser {
    data class Parsed(
        /** The first occurrence when there is a recurrence. */
        val date: LocalDate?,
        /** Null with a date means all-day. */
        val time: LocalTime?,
        /** iCalendar RRULE body, no `RRULE:` prefix. */
        val recurrence: String?,
        /** True when something vague was guessed ("morning", "next week", "at 5"): show it for confirmation. */
        val approx: Boolean,
        /** The input with the claimed spans removed; this is what the model gets. */
        val rest: String,
        val spans: List<Span>,
    )

    data class Span(val kind: String, val text: String)

    fun parse(text: String, now: LocalDateTime = LocalDateTime.now()): Parsed {
        val ctx = Ctx(now.toLocalDate(), now.hour * 60 + now.minute, text)

        val found = ArrayList<Found>()
        for ((order, rule) in rules.withIndex()) {
            for (m in rule.re.findAll(text)) {
                val hit = rule.fn(m, ctx) ?: continue
                if (rule.kind == Kind.DATE && hit.date == null) continue
                found += Found(rule.kind, m.range.first, m.range.last + 1, m.value, hit, order)
            }
        }
        // Longest span wins; ties go to the earlier-registered rule, which is the more specific one.
        val ranked = found.sortedWith(compareByDescending<Found> { it.end - it.start }.thenBy { it.order })
        val picked = ArrayList<Found>()
        for (f in ranked) if (picked.none { f.start < it.end && it.start < f.end }) picked += f
        picked.sortBy { it.start }

        // One of each kind; later dates and times stay in the text for the model to see. Recurrence prefers the
        // span that names days ("on fridays") over a generic one ("weekly"); leftover generic ones are cut.
        // Repeat phrases that describe one repeat are merged: "every 2 weeks ... on wednesdays", "every morning on weekdays",
        // "biweekly on mondays". The base is the most specific one; the rest of its frequency (and any generic or day-part one) joins it.
        val recs = picked.filter { it.kind == Kind.REC }
        val partRec = recs.firstOrNull { it.hit.partName != null }
        val base = recs.firstOrNull { !it.hit.anchorless && it.hit.partName == null } ?: partRec ?: recs.firstOrNull()
        val (rec, joined) = if (base != null) mergeRecs(base, recs, text, picked.filter { it.kind != Kind.REC }) else null to emptyList()
        // A day part that did not join the repeat ("... every morning" far from it) stays in the text and does not set the time.
        val activePart = if (partRec != null && (partRec === base || partRec in joined)) partRec else null
        // The first time phrase wins. A clock time beside a day part refines it: "afternoon at 4pm" is 16:00 and "morning at 7" is
        // 07:00, with only that day part consumed. A later, unrelated time ("tomorrow morning, dinner at 7pm") stays in the text.
        val times = picked.filter { it.kind == Kind.TIME }
        // "daily until november 1": a date after "until" ends a repeat; it is not where the repeat starts.
        val firstDate = picked.firstOrNull { f -> f.kind == Kind.DATE && !(base != null && untilCue.containsMatchIn(text.substring(0, f.start))) }
        val dates = picked.filter { it.kind == Kind.DATE }
        // Two phrases are "beside" each other when only spaces and commas separate them, or one date phrase and no comma:
        // "at 7 tomorrow morning" counts, "tomorrow morning, friday at 7pm" does not.
        fun adjacent(a: Found, b: Found): Boolean {
            val (x, y) = if (a.start < b.start) a to b else b to a
            val gap = text.substring(x.end, y.start)
            val inside = dates.filter { it.start >= x.end && it.end <= y.start }
            if (inside.isEmpty()) return gap.all { it.isWhitespace() || it == ',' }
            if (',' in gap || inside.size > 1) return false
            return gap.replaceFirst(text.substring(inside[0].start, inside[0].end), "").isBlank()
        }
        val head = times.firstOrNull()
        val partner = head?.let { h -> times.firstOrNull { it !== h && it.hit.part != h.hit.part && adjacent(it, h) } }
        val firstTime = if (partner != null && head.hit.part) partner else head
        val dayPart = if (partner != null) (if (head.hit.part) head else partner) else null
        val used = picked.filter { it === firstDate || it === firstTime || it === base || it in joined || it === dayPart }
        var date = firstDate?.hit?.date
        var time = firstTime?.hit?.time ?: firstDate?.hit?.time ?: (activePart ?: base)?.hit?.time
        val amb = firstTime?.hit?.amb
        // "every morning at 7" and "tonight at 9": a day part carried by a repeat or a date span settles the hour the same way.
        // The merged repeat counts as one phrase: "every morning on weekdays at 7" is 07:00 though "on weekdays" sits between.
        val recGroup = if (base != null) listOf(base) + joined else emptyList()
        val partOwner = listOfNotNull(activePart, firstDate).firstOrNull {
            it.hit.partName != null && firstTime != null && !firstTime.hit.part &&
                (if (it === activePart) recGroup.any { g -> adjacent(g, firstTime) } else adjacent(it, firstTime))
        }
        val partName = dayPart?.hit?.partName ?: partOwner?.hit?.partName
        val resolvedByDayPart = partName != null && amb != null
        if (partName != null && amb != null) time = hhmm((dayPartHour(amb.first, partName) * 60 + amb.second + 1440) % 1440)
        // A repeat's own default time ("every morning" is 09:00) is only a guess when no clock time was given.
        val approx = listOfNotNull(firstDate, if (resolvedByDayPart) null else firstTime, if (firstTime != null) null else (activePart ?: base))
            .any { it.hit.approx } || base?.hit?.anchorless == true || (firstTime == null && firstDate?.hit?.timeApprox == true)

        val timeMin = time?.let { it.substring(0, 2).toInt() * 60 + it.substring(3).toInt() }
        fun afterNow(d: LocalDate) = d.isAfter(ctx.today) || timeMin == null || timeMin > ctx.nowMin
        if (rec != null) {
            // The first occurrence is the first day the rule allows on or after the start: an explicit "starting
            // tomorrow" is the lower bound, otherwise today (which only counts while its time is still ahead).
            val anchor = date
            val from = date ?: ctx.today
            // Long enough to reach the next aligned step of any interval ("every 3 years starting today").
            val perStep = when (rec.freq) { "DAILY" -> 2; "WEEKLY" -> 8; "MONTHLY" -> 32; "YEARLY" -> 1500; else -> 400 }
            val searchDays = maxOf(800, perStep * (rec.interval + 1) + 400)
            var found = false
            for (i in 0 until searchDays) {
                val d = from.plusDays(i.toLong())
                if (matches(rec, d, anchor) && (d != ctx.today || afterNow(d))) { date = d; found = true; break }
            }
            if (!found && anchor != null) date = null // no aligned day in reach (a leap day eight years out): leave the date to the person
        } else if (date == null && time != null) {
            date = if (afterNow(ctx.today)) ctx.today else ctx.today.plusDays(1)
        }
        // "tonight at 1am" is after midnight: the next calendar day, not the hour that has already passed.
        if (firstDate?.hit?.partName == "night" && rec == null && date != null && time != null && time.substring(0, 2).toInt() < 6) date = date.plusDays(1)

        var rest = StringBuilder()
        var at = 0
        val cuts = used.map { f ->
            val dangling = (if (f in joined) danglingJoined else dangling).find(text.substring(0, f.start))
            Cut(if (dangling != null) f.start - dangling.value.length else f.start, f.end)
        }.sortedBy { it.start }
        for (c in cuts) {
            if (c.start >= at) rest.append(text, at, c.start).append(' ')
            at = maxOf(at, c.end)
        }
        rest.append(text, minOf(at, text.length), text.length)
        val cleaned = rest.toString().replace(whitespace, " ").replace(spaceBeforePunct, "$1").replace(edgePunct, "")

        return Parsed(
            date = date,
            time = time?.let { runCatching { LocalTime.parse(it) }.getOrNull() },
            recurrence = rec?.let(::buildRule),
            approx = approx,
            rest = cleaned,
            spans = used.map { Span(it.kind.name.lowercase(), it.text) },
        )
    }

    // ---- types ----

    private enum class Kind { REC, DATE, TIME }

    private data class Rec(
        val freq: String,
        val interval: Int = 1,
        val byday: List<String>? = null,
        val bymonthday: List<Int>? = null,
        /** (n, weekday) for "every second tuesday"; n is -1 for "last". */
        val nth: Pair<Int, Int>? = null,
    )

    private class Hit(
        val date: LocalDate? = null,
        val time: String? = null,
        val approx: Boolean = false,
        val rec: Rec? = null,
        val anchorless: Boolean = false,
        /** A part of the day ("afternoon"), which a clock time in the same phrase overrides. */
        val part: Boolean = false,
        val partName: String? = null,
        /** The hit carries a default time ("tonight" is 20:00) that is only a guess when no clock time was given. */
        val timeApprox: Boolean = false,
        /** An ambiguous clock hour as typed (1 to 12) and its minutes, so a day part beside it can settle am or pm. */
        val amb: Pair<Int, Int>? = null,
    )

    private class Ctx(val today: LocalDate, val nowMin: Int, val text: String)
    private class Found(val kind: Kind, val start: Int, val end: Int, val text: String, val hit: Hit, val order: Int)
    private class Cut(val start: Int, val end: Int)
    private class Rule(val kind: Kind, source: String, val fn: (MatchResult, Ctx) -> Hit?) {
        // Every recognizer starts on a word boundary, so "each morning" is not found inside "teach morning".
        val re = Regex(if (source.startsWith("""\b""") || source.startsWith("(?<=")) source else """\b""" + source, RegexOption.IGNORE_CASE)
    }

    private enum class Mode { AFTER, ON_OR_AFTER, NEXT_WEEK }

    // ---- vocabulary ----

    private val WD3 = listOf("sun", "mon", "tue", "wed", "thu", "fri", "sat")
    private val RR_DAY = listOf("SU", "MO", "TU", "WE", "TH", "FR", "SA")
    private val MON3 = listOf("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
    private const val WD_FULL = "monday|tuesday|wednesday|thursday|friday|saturday|sunday"
    private const val WD_ANY = "$WD_FULL|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun"
    private const val MONTH = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec"
    private const val ORDINAL = "(\\d{1,2})(?:st|nd|rd|th)?"
    private const val WD_LIST = "(?:$WD_ANY)s?"
    private val NUM_WORD = mapOf("a" to 1, "an" to 1, "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6, "seven" to 7, "eight" to 8, "nine" to 9, "ten" to 10)
    private val HOUR_WORD = mapOf("one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6, "seven" to 7, "eight" to 8, "nine" to 9, "ten" to 10, "eleven" to 11, "twelve" to 12)
    private const val HOUR = "\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve"
    // Phrases of one repeat are merged only when they agree. A constraint-free cadence ("every 2 weeks", "biweekly") lends its
    // interval to a constrained phrase ("on wednesdays"); two constrained phrases must share an interval and a kind of day list
    // ("mondays and on fridays"). Anything else ("every monday and every other friday", "every 15th and every second tuesday",
    // a second day part) stays in the text rather than being silently dropped.
    private fun constrained(r: Rec) = r.byday != null || r.bymonthday != null || r.nth != null

    private fun compatible(m: Rec, r: Rec): Boolean {
        if (constrained(m) && constrained(r)) {
            if (m.interval != r.interval || m.nth != null || r.nth != null) return false
            return (m.byday != null) == (r.byday != null) && (m.bymonthday != null) == (r.bymonthday != null)
        }
        val c = if (constrained(m)) m else r
        val f = if (constrained(m)) r else m
        return c.interval == 1 || c.interval == f.interval
    }

    private fun mergeInto(m: Rec, r: Rec): Rec {
        val nthSrc = if (m.nth != null) m else if (r.nth != null) r else null
        return m.copy(
            interval = maxOf(m.interval, r.interval),
            byday = if (nthSrc != null) nthSrc.byday else unionOf(m.byday, r.byday),
            bymonthday = unionOf(m.bymonthday, r.bymonthday),
            nth = nthSrc?.nth,
        )
    }

    // Two phrases describe one repeat only if the text between them agrees: day lists and day parts need nothing but connectors
    // ("on mondays and on fridays", "every morning on weekdays"), a bare cadence may sit anywhere in the same sentence
    // ("weekly review on fridays"). Dates and times between them ("starting tomorrow", "at 7") do not break the link.
    private val connectors = Regex("""^(?:\s|,|&|and|on|starting|from|at|each)*$""", RegexOption.IGNORE_CASE)

    private fun mergeRecs(base: Found, recs: List<Found>, text: String, others: List<Found>): Pair<Rec, List<Found>> {
        var m = base.hit.rec!!
        val joined = ArrayList<Found>()
        val group = arrayListOf(base)
        var partJoined = base.hit.partName != null
        fun connected(f: Found) = group.any { g ->
            val (x, y) = if (g.start < f.start) g to f else f to g
            var gap = text.substring(x.end, y.start)
            for (o in others) if (o.start >= x.end && o.end <= y.start) gap = gap.replaceFirst(text.substring(o.start, o.end), "")
            val strict = g.hit.partName != null || f.hit.partName != null || (constrained(g.hit.rec!!) && constrained(f.hit.rec!!))
            if (strict) connectors.matches(gap) else gap.none { it in ".;!?" }
        }
        for (f in recs) {
            if (f === base) continue
            if (f.hit.partName != null) { // a second day part stays in the text
                if (!partJoined && connected(f)) { partJoined = true; joined += f; group += f }
                continue
            }
            val r = f.hit.rec ?: continue
            if (r.freq != m.freq || !compatible(m, r) || !connected(f)) continue
            joined += f
            group += f
            m = mergeInto(m, r)
        }
        return m to joined
    }

    private fun <T> unionOf(vararg lists: List<T>?): List<T>? = lists.flatMap { it ?: emptyList() }.distinct().ifEmpty { null }
    // "daily except weekends": a day list that something is excluded from is not the repeat's own day list.
    private val exceptCue = Regex("""\b(?:except|excluding|but\s+not|not\s+on|besides)\s+(?:on\s+)?(?:the\s+)?$""", RegexOption.IGNORE_CASE)
    private fun excluded(m: MatchResult, c: Ctx) = exceptCue.containsMatchIn(c.text.substring(0, m.range.first))
    private val ORDINAL_WORD = mapOf("first" to 1, "second" to 2, "third" to 3, "fourth" to 4, "fifth" to 5, "sixth" to 6, "seventh" to 7, "eighth" to 8, "ninth" to 9, "tenth" to 10, "fifteenth" to 15, "twentieth" to 20, "thirtieth" to 30)
    private val untilCue = Regex("""\b(?:until|till|through|thru)\s+$""", RegexOption.IGNORE_CASE)
    private fun hourOf(s: String): Int = s.toIntOrNull() ?: HOUR_WORD.getValue(s.lowercase())
    private const val LIST_SEP = "(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*)"
    private val PART_OF_DAY = mapOf("morning" to "09:00", "afternoon" to "14:00", "evening" to "18:00", "night" to "21:00")
    private val FREQ_OF_UNIT = mapOf("day" to "DAILY", "week" to "WEEKLY", "month" to "MONTHLY", "year" to "YEARLY")
    private val NTH_WORD = mapOf("first" to 1, "second" to 2, "third" to 3, "fourth" to 4, "last" to -1)

    private val dangling = Regex("""(?:\s*,|\s+(?:on|at|by|due|before|until|from|starting|each))+\s*$""", RegexOption.IGNORE_CASE)
    // A phrase that joined an earlier repeat also takes the "and" that linked them ("on mondays and on fridays").
    private val danglingJoined = Regex("""(?:\s*,|\s+(?:on|at|by|due|before|until|from|starting|each|and))+\s*$""", RegexOption.IGNORE_CASE)
    private val inThe = Regex("""\bin\s+the\b""", RegexOption.IGNORE_CASE)
    private val dateCue = Regex("""\b(?:on|by|due|before|until|from|starting|after)\s+$""", RegexOption.IGNORE_CASE)
    private val whitespace = Regex("""\s+""")
    private val spaceBeforePunct = Regex("""\s+([,.;!?])""")
    private val edgePunct = Regex("""^[\s,.;:!—–-]+|[\s,.;:!—–-]+$""")

    // ---- calendar arithmetic (JS Date.UTC semantics: month and day overflow roll over) ----

    private fun mk(y: Int, m: Int, d: Int): LocalDate = LocalDate.of(y, 1, 1).plusMonths(m.toLong()).plusDays((d - 1).toLong())
    private fun dow(d: LocalDate) = d.dayOfWeek.value % 7
    private fun daysInMonth(y: Int, m: Int) = mk(y, m + 1, 0).dayOfMonth
    private fun pad(n: Int) = n.toString().padStart(2, '0')
    private fun hhmm(min: Int) = "${pad(min / 60)}:${pad(min % 60)}"
    private fun wdIndex(s: String) = WD3.indexOf(s.lowercase().take(3))
    private fun monthIndex(s: String) = MON3.indexOf(s.lowercase().take(3))
    private fun MatchResult.g(i: Int): String? = groups[i]?.value

    /** AFTER: strictly after today. ON_OR_AFTER: today counts. NEXT_WEEK: that weekday in the Monday-to-Sunday week after this one. */
    private fun weekdayDate(today: LocalDate, wd: Int, mode: Mode): LocalDate {
        val delta = (wd - dow(today) + 7) % 7
        return when (mode) {
            Mode.ON_OR_AFTER -> today.plusDays(delta.toLong())
            Mode.AFTER -> today.plusDays((if (delta == 0) 7 else delta).toLong())
            Mode.NEXT_WEEK -> {
                val toNextMonday = ((8 - dow(today)) % 7).let { if (it == 0) 7 else it }
                today.plusDays((toNextMonday + (wd + 6) % 7).toLong())
            }
        }
    }

    /** A month/day without a year means the next time that date comes around, today included. */
    private fun nextMonthDay(today: LocalDate, month: Int, day: Int): LocalDate? {
        // Nine years of look-ahead so that "feb 29" finds the next leap year.
        for (k in 0 until 9) {
            val y = today.year + k
            if (day > daysInMonth(y, month)) continue
            val d = mk(y, month, day)
            if (!d.isBefore(today)) return d
        }
        return null
    }

    /** A date the text spells out in full must exist; "2026-02-30" is left alone instead of rolling over to 2 March. */
    private fun explicitDate(y: Int, m: Int, d: Int): LocalDate? =
        if (m < 0 || m > 11 || d < 1 || d > daysInMonth(y, m)) null else mk(y, m, d)

    private fun nthWeekdayOfMonth(y: Int, m: Int, n: Int, wd: Int): LocalDate? {
        if (n > 0) {
            val day = 1 + (wd - dow(mk(y, m, 1)) + 7) % 7 + 7 * (n - 1)
            return if (day > daysInMonth(y, m)) null else mk(y, m, day)
        }
        val last = mk(y, m + 1, 0)
        return last.minusDays(((dow(last) - wd + 7) % 7).toLong())
    }

    private fun buildRule(r: Rec): String = listOfNotNull(
        "FREQ=${r.freq}",
        if (r.interval > 1) "INTERVAL=${r.interval}" else null,
        r.byday?.let { "BYDAY=${it.joinToString(",")}" },
        r.bymonthday?.let { "BYMONTHDAY=${it.joinToString(",")}" },
    ).joinToString(";")

    // With an explicit start ("every 2 days starting today") the interval counts from it, so a day that matches the rule
    // but falls between the steps does not count. Weeks run Monday to Sunday, as everywhere else in this file.
    private fun weekIdx(d: LocalDate) = Math.floorDiv(d.toEpochDay() + 3, 7L)

    private fun alignedWithStart(r: Rec, d: LocalDate, a: LocalDate): Boolean {
        val n = r.interval
        return when (r.freq) {
            "DAILY" -> (d.toEpochDay() - a.toEpochDay()) % n == 0L
            "WEEKLY" -> (weekIdx(d) - weekIdx(a)) % n == 0L && (r.byday != null || dow(d) == dow(a))
            "MONTHLY" -> {
                val months = d.year * 12L + d.monthValue - (a.year * 12L + a.monthValue)
                months % n == 0L && (r.bymonthday != null || r.nth != null || d.dayOfMonth == a.dayOfMonth)
            }
            else -> (d.year - a.year) % n == 0 && d.monthValue == a.monthValue && d.dayOfMonth == a.dayOfMonth
        }
    }

    private fun matches(r: Rec, d: LocalDate, anchor: LocalDate?): Boolean {
        if (anchor != null && !alignedWithStart(r, d, anchor)) return false
        if (r.freq == "WEEKLY" && r.byday != null) return RR_DAY[dow(d)] in r.byday
        if (r.freq == "MONTHLY" && r.bymonthday != null)
            return r.bymonthday.any { n -> if (n == -1) d.dayOfMonth == daysInMonth(d.year, d.monthValue - 1) else d.dayOfMonth == n }
        if (r.freq == "MONTHLY" && r.nth != null)
            return nthWeekdayOfMonth(d.year, d.monthValue - 1, r.nth.first, r.nth.second) == d
        return true
    }

    private fun bydayOf(source: String, words: String): List<String> =
        Regex("""\b($words)""", RegexOption.IGNORE_CASE).findAll(source).map { RR_DAY[wdIndex(it.groupValues[1])] }.distinct().toList()

    // Nobody says "at 5" meaning 5am; 8 to 11 are the morning hours.
    private fun bareHour(h: Int) = if (h in 8..11) h else h % 12 + 12

    // With a day part beside it the hour is no longer a guess: "morning at 7" is 07:00 and "evening at 7" is 19:00.
    private fun dayPartHour(h: Int, part: String?) = when (part) {
        "morning" -> h % 12
        "night" -> if (h == 12) 0 else if (h >= 6) h + 12 else h
        else -> if (h == 12) 12 else h + 12
    }

    private fun clock(h: Int, min: Int, ap: String): String? {
        if (h < 1 || h > 12 || min > 59) return null
        return "${pad(h % 12 + if (ap.startsWith("p", ignoreCase = true)) 12 else 0)}:${pad(min)}"
    }

    // ---- the recognizers, in priority order (ties on span length go to the earlier one) ----

    private val rules: List<Rule> = buildList {
        fun rule(kind: Kind, source: String, fn: (MatchResult, Ctx) -> Hit?) { add(Rule(kind, source, fn)) }
        fun rec(source: String, fn: (MatchResult) -> Hit?) = rule(Kind.REC, source) { m, _ -> fn(m) }
        fun date(source: String, fn: (MatchResult, Ctx) -> Hit?) = rule(Kind.DATE, source, fn)
        fun time(source: String, fn: (MatchResult) -> Hit?) = rule(Kind.TIME, source) { m, _ -> fn(m) }
        fun monthly(vararg days: Int): Hit? = if (days.all { it in 1..31 }) Hit(rec = Rec("MONTHLY", bymonthday = days.toList())) else null

        // ---- recurrence ----
        rec("""(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\s+of\s+(?:every|each)\s+month\b""") { m -> monthly(m.g(1)!!.toInt()) }
        rec("""(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+and\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\s+of\s+(?:every|each)\s+month\b""") { m ->
            monthly(m.g(1)!!.toInt(), m.g(2)!!.toInt())
        }
        rec("""(?:(?:every|each)\s+month|monthly)\s+on\s+the\s+$ORDINAL\b""") { m -> monthly(m.g(1)!!.toInt()) }
        // "every 15th" is a day of the month only when no weekday follows ("every 2nd tuesday" is the nth weekday).
        rec("""(?:every|each)\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:of|day|week|month|(?:$WD_ANY)\b))""") { m -> monthly(m.g(1)!!.toInt()) }
        rec("""(?:on\s+)?the\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|fifteenth|twentieth|thirtieth)\s+of\s+(?:every|each)\s+month\b""") { m ->
            monthly(ORDINAL_WORD.getValue(m.g(1)!!.lowercase()))
        }
        rec("""(?:on\s+)?the\s+last\s+day\s+of\s+(?:every|each)\s+month\b""") { Hit(rec = Rec("MONTHLY", bymonthday = listOf(-1))) }
        rec("""(?:every|each)\s+(first|second|third|fourth|last|\d{1,2}(?:st|nd|rd|th))\s+($WD_ANY)(?:\s+of\s+the\s+month)?\b""") { m ->
            val word = m.g(1)!!.lowercase()
            val n = NTH_WORD[word] ?: word.dropLast(2).toInt()
            val wd = wdIndex(m.g(2)!!)
            // A month has at most five of a weekday.
            if (n != -1 && n !in 1..5) null else Hit(rec = Rec("MONTHLY", byday = listOf("$n${RR_DAY[wd]}"), nth = n to wd))
        }
        rec("""(?:every|each)\s+other\s+($WD_ANY)\b""") { m -> Hit(rec = Rec("WEEKLY", interval = 2, byday = listOf(RR_DAY[wdIndex(m.g(1)!!)]))) }
        // "every 2 weeks on wednesdays": the weekday list belongs to a weekly interval only.
        rec("""(?:every|each)\s+(\d+|other|two|three|four)\s+weeks?(?:\s+on\s+($WD_LIST(?:$LIST_SEP$WD_LIST)*))?\b""") { m ->
            val word = m.g(1)!!.lowercase()
            val interval = if (word == "other") 2 else word.toIntOrNull() ?: NUM_WORD[word]
            // The worker allows up to 999; nothing a person says needs more than 99, and it keeps the first-occurrence search short.
            if (interval == null || interval < 1 || interval > 99) null
            else Hit(rec = Rec("WEEKLY", interval, byday = m.g(2)?.let { bydayOf(it, WD_ANY) }))
        }
        // "every 2 months on the 31st": the day of the month belongs to a monthly interval only.
        rec("""(?:every|each)\s+(\d+|other|two|three|four)\s+(day|month|year)s?(?:\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th))?\b""") { m ->
            val freq = FREQ_OF_UNIT.getValue(m.g(2)!!.lowercase())
            val word = m.g(1)!!.lowercase()
            val interval = if (word == "other") 2 else word.toIntOrNull() ?: NUM_WORD[word]
            val dom = m.g(3)?.toInt()
            if (interval == null || interval < 1 || interval > 99) null
            else if (dom != null && (freq != "MONTHLY" || dom !in 1..31)) null
            else Hit(rec = Rec(freq, interval, bymonthday = dom?.let { listOf(it) }))
        }
        rule(Kind.REC, """\b(weekday|weekend)s\b""") { m, c ->
            if (excluded(m, c)) return@rule null
            Hit(rec = Rec("WEEKLY", byday = if (m.g(1)!!.lowercase() == "weekday") listOf("MO", "TU", "WE", "TH", "FR") else listOf("SA", "SU")))
        }
        // "gym mon wed fri": two or more abbreviations in a row, no "every" needed.
        rec("""\b(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?:(?:\s*,\s*|\s+)(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun))+\b""") { m ->
            Hit(rec = Rec("WEEKLY", byday = Regex("[a-z]+", RegexOption.IGNORE_CASE).findAll(m.value).map { RR_DAY[wdIndex(it.value)] }.distinct().toList()))
        }
        // "every Monday-Friday", "every monday to thursday": a run of days, inclusive, wrapping past Sunday if need be.
        rec("""(?:every|each)\s+($WD_ANY)\s*(?:-|–|to|through|thru)\s*($WD_ANY)\b""") { m ->
            val days = ArrayList<String>()
            var i = wdIndex(m.g(1)!!)
            val end = wdIndex(m.g(2)!!)
            while (true) { days += RR_DAY[i]; if (i == end || days.size > 7) break; i = (i + 1) % 7 }
            Hit(rec = Rec("WEEKLY", byday = days))
        }
        rec("""(?:every|each)\s+(weekday|weekend)s?\b""") { m ->
            Hit(rec = Rec("WEEKLY", byday = if (m.g(1)!!.lowercase() == "weekday") listOf("MO", "TU", "WE", "TH", "FR") else listOf("SA", "SU")))
        }
        rec("""(?:every|each)\s+$WD_LIST(?:$LIST_SEP(?:every\s+)?$WD_LIST)*\b""") { m ->
            Hit(rec = Rec("WEEKLY", byday = bydayOf(m.value, WD_ANY)))
        }
        rule(Kind.REC, """\b(?:on\s+)?(?:$WD_FULL)s(?:$LIST_SEP(?:$WD_FULL)s)*\b""") { m, c ->
            if (excluded(m, c)) return@rule null
            Hit(rec = Rec("WEEKLY", byday = bydayOf(m.value, WD_FULL)))
        }
        rec("""(?:every|each)\s+(morning|afternoon|evening|night)\b""") { m ->
            Hit(rec = Rec("DAILY"), time = PART_OF_DAY.getValue(m.g(1)!!.lowercase()), approx = true, partName = m.g(1)!!.lowercase())
        }
        rec("""(?:every|each)\s+(day|week|month|year)\b""") { m ->
            Hit(rec = Rec(FREQ_OF_UNIT.getValue(m.g(1)!!.lowercase())), anchorless = true)
        }
        rec("""\b(daily|weekly|monthly|yearly|annually|biweekly|fortnightly)\b""") { m ->
            val w = m.g(1)!!.lowercase()
            val freq = mapOf("daily" to "DAILY", "weekly" to "WEEKLY", "monthly" to "MONTHLY", "yearly" to "YEARLY", "annually" to "YEARLY", "biweekly" to "WEEKLY", "fortnightly" to "WEEKLY").getValue(w)
            Hit(rec = Rec(freq, if (w == "biweekly" || w == "fortnightly") 2 else 1), anchorless = true)
        }

        // ---- dates ----
        date("""\bday\s+after\s+tomorrow\b""") { _, c -> Hit(date = c.today.plusDays(2)) }
        date("""\b(?:to?m{1,2}o?r{1,2}ow|tmr|tmrw|tmw|2morrow|2moro)\b""") { _, c -> Hit(date = c.today.plusDays(1)) }
        date("""\btoday\b""") { _, c -> Hit(date = c.today) }
        date("""\b(?:eod|cob)\b""") { _, c -> Hit(date = c.today) }
        // "this morning" is today even when the 09:00 default has passed.
        date("""\bthis\s+(morning|afternoon|evening)\b""") { m, c ->
            val p = m.g(1)!!.lowercase()
            Hit(date = c.today, time = PART_OF_DAY.getValue(p), timeApprox = true, partName = p)
        }
        date("""\btonight\b""") { _, c -> Hit(date = c.today, time = "20:00", timeApprox = true, partName = "night") }
        date("""\b(?:(next|this|coming)\s+)?($WD_FULL)\b""") { m, c ->
            val mode = when (m.g(1)?.lowercase()) { "next" -> Mode.NEXT_WEEK; "this" -> Mode.ON_OR_AFTER; else -> Mode.AFTER }
            Hit(date = weekdayDate(c.today, wdIndex(m.g(2)!!), mode))
        }
        date("""\b(tues|thurs?|thu|weds?|fri)\b""") { m, c -> Hit(date = weekdayDate(c.today, wdIndex(m.g(1)!!), Mode.AFTER)) }
        // "mon" is also a word, so it only counts as Monday before a time or at the end: "dentist mon at 2pm".
        date("""\bmon\b(?=\s+(?:at|morning|afternoon|evening|night)\b|\s*$)""") { _, c -> Hit(date = weekdayDate(c.today, 1, Mode.AFTER)) }
        date("""\b(?:on|next|this)\s+($WD_ANY)\b""") { m, c ->
            val mode = if (m.value.startsWith("next", true)) Mode.NEXT_WEEK else if (m.value.startsWith("this", true)) Mode.ON_OR_AFTER else Mode.AFTER
            Hit(date = weekdayDate(c.today, wdIndex(m.g(1)!!), mode))
        }
        date("""\b(this|next)\s+weekend\b""") { m, c ->
            Hit(date = weekdayDate(c.today, 6, if (m.g(1)!!.lowercase() == "next") Mode.NEXT_WEEK else Mode.ON_OR_AFTER), approx = true)
        }
        // "in 1 hour 30 minutes", "in an hour and 15 minutes": one span, so the minutes are not left behind.
        // "in an hour and a half", "in half an hour".
        date("""\bin\s+(?:an?\s+|one\s+)hour\s+and\s+a\s+half\b""") { _, c ->
            val t = c.nowMin + 90
            Hit(date = c.today.plusDays((t / 1440).toLong()), time = hhmm(t % 1440))
        }
        date("""\bin\s+half\s+an\s+hour\b""") { _, c ->
            val t = c.nowMin + 30
            Hit(date = c.today.plusDays((t / 1440).toLong()), time = hhmm(t % 1440))
        }
        date("""\bin\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hours?|hrs?)\s+(?:and\s+)?(\d+)\s+(?:minutes?|mins?)\b""") { m, c ->
            val word = m.g(1)!!.lowercase()
            val h = word.toIntOrNull() ?: NUM_WORD[word]
            val mi = m.g(2)!!.toIntOrNull()
            if (h == null || mi == null || h < 1 || h > 2000 || mi > 59 || h * 60 + mi > 100_000) null
            else {
                val t = c.nowMin + h * 60 + mi
                Hit(date = c.today.plusDays((t / 1440).toLong()), time = hhmm(t % 1440))
            }
        }
        date("""\bin\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(minute|min|hour|hr|day|week|month)s?\b""") { m, c ->
            val word = m.g(1)!!.lowercase()
            val n = word.toIntOrNull() ?: NUM_WORD[word]
            val unit = m.g(2)!!.lowercase().let { if (it == "min") "minute" else if (it == "hr") "hour" else it }
            if (n == null || n < 1 || n > 100_000) null
            else if (unit == "minute" || unit == "hour") {
                val t = c.nowMin + n * (if (unit == "hour") 60 else 1)
                Hit(date = c.today.plusDays((t / 1440).toLong()), time = hhmm(t % 1440))
            } else Hit(date = if (unit == "month") c.today.plusMonths(n.toLong()) else c.today.plusDays(n.toLong() * if (unit == "week") 7 else 1))
        }
        date("""\b(?:the\s+)?end\s+of\s+next\s+(week|month|year)\b""") { m, c ->
            when (m.g(1)!!.lowercase()) {
                "week" -> Hit(date = weekdayDate(c.today, 5, Mode.NEXT_WEEK), approx = true)
                "month" -> Hit(date = mk(c.today.year, c.today.monthValue - 1 + 2, 0))
                else -> Hit(date = mk(c.today.year + 1, 11, 31))
            }
        }
        date("""\bnext\s+(week|month|year)\b""") { m, c ->
            Hit(
                date = when (m.g(1)!!.lowercase()) {
                    "week" -> weekdayDate(c.today, 1, Mode.AFTER)
                    "month" -> mk(c.today.year, c.today.monthValue - 1 + 1, 1)
                    else -> mk(c.today.year + 1, 0, 1)
                },
                approx = true,
            )
        }
        date("""\b(?:the\s+)?end\s+of\s+(?:the\s+)?(day|week|month|year|$MONTH)\b""") { m, c ->
            val u = m.g(1)!!.lowercase()
            val y = c.today.year
            val mo = c.today.monthValue - 1
            when (u) {
                "day" -> Hit(date = c.today)
                "week" -> Hit(date = weekdayDate(c.today, 5, Mode.ON_OR_AFTER), approx = true)
                "month" -> Hit(date = mk(y, mo + 1, 0))
                "year" -> Hit(date = mk(y, 11, 31))
                else -> {
                    val k = monthIndex(u)
                    val d = mk(y, k + 1, 0)
                    Hit(date = if (!d.isBefore(c.today)) d else mk(y + 1, k + 1, 0))
                }
            }
        }
        date("""\b(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?(?!\d)""") { m, _ ->
            // 25:00 is not a time, so this is not a timestamp.
            if (m.g(4) != null && (m.g(4)!!.toInt() > 23 || m.g(5)!!.toInt() > 59)) null
            else Hit(date = explicitDate(m.g(1)!!.toInt(), m.g(2)!!.toInt() - 1, m.g(3)!!.toInt()), time = m.g(4)?.let { "$it:${m.g(5)}" })
        }
        date("""\b(?:on\s+)?(?:(?:$WD_ANY)\.?,?\s+)?(?:the\s+)?($MONTH)\.?\s+$ORDINAL(?:,?\s+(\d{4}))?\b(?!\s*(?::\d|am\b|pm\b))""") { m, c ->
            val mo = monthIndex(m.g(1)!!)
            val day = m.g(2)!!.toInt()
            Hit(date = if (m.g(3) != null) explicitDate(m.g(3)!!.toInt(), mo, day) else nextMonthDay(c.today, mo, day))
        }
        date("""\b(?:on\s+)?(?:(?:$WD_ANY)\.?,?\s+)?(?:the\s+)?$ORDINAL\s+(?:of\s+)?($MONTH)(?:,?\s+(\d{4}))?\b""") { m, c ->
            val mo = monthIndex(m.g(2)!!)
            val day = m.g(1)!!.toInt()
            Hit(date = if (m.g(3) != null) explicitDate(m.g(3)!!.toInt(), mo, day) else nextMonthDay(c.today, mo, day))
        }
        date("""\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b(?!-[a-z])(?!\s*(?:cups?|tsp|tbsp|teaspoons?|tablespoons?|oz|ounces?|lbs?|pounds?|inch(?:es)?|miles?|of|full|empty))""") { m, c ->
            val mo = m.g(1)!!.toInt() - 1
            val d = m.g(2)!!.toInt()
            // A proper fraction (1/2, 3/4, 1/8) is a quantity unless a date cue comes first: "take 1/2 tablet" but "pay by 1/4".
            val quantity = m.g(3) == null && m.g(1)!!.toInt() < d && d in listOf(2, 3, 4, 8) && !dateCue.containsMatchIn(c.text.substring(0, m.range.first))
            if (mo > 11 || d < 1 || d > 31 || quantity) null
            else {
                val year = m.g(3)?.toInt()?.let { if (it < 100) 2000 + it else it }
                Hit(date = if (year != null) explicitDate(year, mo, d) else nextMonthDay(c.today, mo, d))
            }
        }
        // Only when the ordinal ends the phrase: "the 2nd draft" and "the 7th street cafe" are not dates.
        date("""\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b(?=\s*(?:$|[,.;:!?)]|\s(?:at|by|and|or|before|after|in|for|morning|afternoon|evening)\b))""") { m, c ->
            val n = m.g(1)!!.toInt()
            var hit: Hit? = null
            for (i in 0 until 3) {
                val t = mk(c.today.year, c.today.monthValue - 1, 1).plusMonths(i.toLong())
                if (n <= daysInMonth(t.year, t.monthValue - 1) && !mk(t.year, t.monthValue - 1, n).isBefore(c.today)) {
                    hit = Hit(date = mk(t.year, t.monthValue - 1, n)); break
                }
            }
            hit
        }

        // ---- times ----
        time("""\b(?:at\s+)?($HOUR)(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])""") { m ->
            clock(hourOf(m.g(1)!!), m.g(2)?.toInt() ?: 0, m.g(3)!!)?.let { Hit(time = it) }
        }
        time("""\b(at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:am|pm|a\.m|p\.m))""") { m ->
            val h = m.g(2)!!.toInt()
            val min = m.g(3)!!.toInt()
            val clockLike = h in 1..12 && m.g(2)!!.length == (if (h < 10) 1 else 2) // no leading zero: could be 12-hour
            // "at 5:30" is the afternoon; "17:30", "09:00" and a bare "5:30" are taken literally, but a bare "7:30" still lets a day
            // part beside it settle the hour ("evening 7:30" is 19:30).
            if (m.g(1) != null && clockLike && h <= 11) Hit(time = "${pad(bareHour(h))}:${m.g(3)}", approx = true, amb = h to min)
            else Hit(time = "${pad(h)}:${m.g(3)}", amb = if (clockLike) h to min else null)
        }
        // "half past 8pm", "quarter to 8pm": an offset on a clock that already says am or pm.
        time("""\b(?:at\s+)?(half\s+past|quarter\s+past|quarter\s+to)\s+($HOUR)\s*(a\.?m\.?|p\.?m\.?)(?![a-z])""") { m ->
            val h = hourOf(m.g(2)!!)
            if (h < 1 || h > 12) null
            else {
                val offset = if (m.g(1)!!.startsWith("half", true)) 30 else if (m.g(1)!!.contains("past", true)) 15 else -15
                val base = (h % 12) * 60 + if (m.g(3)!!.startsWith("p", true)) 720 else 0
                Hit(time = hhmm((base + offset + 1440) % 1440))
            }
        }
        // "half past 7 in the morning", "quarter to 8 in the evening": the offset and the day part settle one hour together.
        time("""\b(?:at\s+)?(half\s+past|quarter\s+past|quarter\s+to)\s+($HOUR)\s+(?:in\s+the\s+)?(morning|afternoon|evening|night)\b""") { m ->
            val h = hourOf(m.g(2)!!)
            if (h < 1 || h > 12) null
            else {
                val offset = if (m.g(1)!!.startsWith("half", true)) 30 else if (m.g(1)!!.contains("past", true)) 15 else -15
                Hit(time = hhmm((dayPartHour(h, m.g(3)!!.lowercase()) * 60 + offset + 1440) % 1440))
            }
        }
        // A clock and its day part as one phrase: "6 in the morning", "at 7:05 in the evening", "at 12:30 in the morning" (00:30).
        // The lookbehind keeps it from matching the minutes of "7:05" on their own.
        time("""\b(?:at\s+)?(?<![:\d])($HOUR)(?::([0-5]\d))?\s+(?:in\s+the\s+)?(morning|afternoon|evening|night)\b""") { m ->
            val h = hourOf(m.g(1)!!)
            // A bare number needs a clock cue ("at 7 in the evening", "6 in the morning", "7:05 evening"), or "2 night lights"
            // and "3 evening dresses" become times.
            if (h < 1 || h > 12 || (m.g(2) == null && !m.value.startsWith("at", true) && !inThe.containsMatchIn(m.value))) null
            else Hit(time = hhmm(dayPartHour(h, m.g(3)!!.lowercase()) * 60 + (m.g(2)?.toInt() ?: 0)))
        }
        time("""\b(?:at\s+)?($HOUR)\s*o['’]?clock\b""") { m ->
            hourOf(m.g(1)!!).takeIf { it in 1..12 }?.let { Hit(time = "${pad(bareHour(it))}:00", approx = true, amb = it to 0) }
        }
        time("""\b(?:at\s+)?half\s+past\s+($HOUR)\b""") { m ->
            hourOf(m.g(1)!!).takeIf { it in 1..12 }?.let { Hit(time = "${pad(bareHour(it))}:30", approx = true, amb = it to 30) }
        }
        time("""\b(?:at\s+)?quarter\s+(past|to)\s+($HOUR)\b""") { m ->
            val h = hourOf(m.g(2)!!)
            if (h < 1 || h > 12) null
            else if (m.g(1)!!.lowercase() == "past") Hit(time = "${pad(bareHour(h))}:15", approx = true, amb = h to 15)
            // Resolve the named hour first ("quarter to 8" is 07:45, as "at 8" is the morning), then step back a quarter.
            else Hit(time = hhmm((bareHour(h) * 60 - 15 + 1440) % 1440), approx = true, amb = h to -15)
        }
        time("""(?<=\b(?:tomorrow|tonight|today|$WD_FULL)\s)night\b""") { Hit(time = PART_OF_DAY.getValue("night"), approx = true, part = true, partName = "night") }
        time("""\bat\s+(\d{1,2})\b(?!\s*(?:(?:st|nd|rd|th|am|pm)\b|:|/|\d))""") { m ->
            hourOf(m.g(1)!!).takeIf { it in 1..12 }?.let { Hit(time = "${pad(bareHour(it))}:00", approx = true, amb = it to 0) }
        }
        // A spelled-out hour needs a clock-like continuation: "lunch at one tomorrow" is 13:00, "at one point tomorrow" is not a time.
        time("""\bat\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?=\s*(?:$|[,.;:!?)]|\s(?:tomorrow|today|tonight|on|in|and|this|next|every|each|morning|afternoon|evening|night|o'?clock)\b))""") { m ->
            val h = hourOf(m.g(1)!!)
            Hit(time = "${pad(bareHour(h))}:00", approx = true, amb = h to 0)
        }
        time("""\b(?:at\s+)?(noon|midday|midnight)\b""") { m -> Hit(time = if (m.g(1)!!.lowercase() == "midnight") "00:00" else "12:00") }
        time("""\b(?:in\s+the\s+)?(morning|afternoon|evening)\b""") { m -> Hit(time = PART_OF_DAY.getValue(m.g(1)!!.lowercase()), approx = true, part = true, partName = m.g(1)!!.lowercase()) }
    }
}
