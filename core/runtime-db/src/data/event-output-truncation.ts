import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { RETAINED_EVENT_OUTPUT_TARGETS } from "../retained-event-output.js";
import { events } from "../schema.js";

const INLINE_OUTPUT_JSON_PATHS = Array.from(
  new Set(
    RETAINED_EVENT_OUTPUT_TARGETS.map(
      (target) => `$.item.${target.outputPath}`,
    ),
  ),
);

const NOOP_JSON_PATH = "$.__hyperfide_timeline_truncation_noop__";

function truncationMarkerSql(originalLength: SQL, max: number): SQL {
  return sql`char(10) || '…[' || printf('%,d', ${originalLength} - ${max}) || ' more characters truncated]'`;
}

export function truncatedEventDataColumn(
  maxInlineOutputChars: number,
  dialect?: string,
): SQL<string> {
  if (dialect === "postgresql")
    return sql<string>`platform.hyperfide_inline_event_data(${events.data}, ${maxInlineOutputChars}, ARRAY[${sql.join(
      INLINE_OUTPUT_JSON_PATHS.map((path) => sql`${path}`),
      sql`, `,
    )}]::text[])`;
  const pairs: SQL[] = [];
  for (const path of INLINE_OUTPUT_JSON_PATHS) {
    const value = sql`json_extract(${events.data}, ${path})`;
    const overflows = sql`json_type(${events.data}, ${path}) = 'text' AND length(${value}) > ${maxInlineOutputChars}`;
    pairs.push(
      sql`CASE WHEN ${overflows} THEN ${path} ELSE ${NOOP_JSON_PATH} END`,
      sql`substr(${value}, 1, ${maxInlineOutputChars}) || ${truncationMarkerSql(sql`length(${value})`, maxInlineOutputChars)}`,
    );
  }

  return sql<string>`CASE
    WHEN length(${events.data}) <= ${maxInlineOutputChars} THEN ${events.data}
    ELSE json_replace(${events.data}, ${sql.join(pairs, sql`, `)})
  END`;
}
