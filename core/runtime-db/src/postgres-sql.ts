// The data layer's shared SQL uses these portable helpers on both engines.
export const postgresCompatibilitySql = `
CREATE OR REPLACE FUNCTION platform.hyperfide_timeline_budget_rows(query text, bindings jsonb, max_bytes bigint)
RETURNS TABLE(created_at bigint, data_bytes bigint, sequence bigint, turn_id text) LANGUAGE plpgsql AS $$
DECLARE source text := query; i integer; row record; cursor_rows refcursor; total_bytes bigint := 0; count_rows integer := 0;
BEGIN
  FOR i IN REVERSE jsonb_array_length(bindings)..1 LOOP
    source := replace(source, '$' || i, quote_nullable(bindings ->> (i - 1)));
  END LOOP;
  OPEN cursor_rows FOR EXECUTE source;
  LOOP
    FETCH cursor_rows INTO row;
    EXIT WHEN NOT FOUND;
    created_at := row.created_at; data_bytes := row.data_bytes; sequence := row.sequence; turn_id := row.turn_id;
    RETURN NEXT;
    count_rows := count_rows + 1;
    EXIT WHEN count_rows > 1 AND total_bytes + row.data_bytes > max_bytes;
    total_bytes := total_bytes + row.data_bytes;
  END LOOP;
  CLOSE cursor_rows;
END $$;
CREATE OR REPLACE FUNCTION platform.hyperfide_inline_event_data(value text, max_chars integer, paths text[]) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb; p text; key_path text[]; output text; original_length integer;
BEGIN
  IF length(value) <= max_chars THEN RETURN value; END IF;
  result := value::jsonb;
  FOREACH p IN ARRAY paths LOOP
    key_path := string_to_array(trim(leading '$.' from p), '.');
    IF jsonb_typeof(result #> key_path) = 'string' THEN
      output := result #>> key_path;
      original_length := length(output);
      IF original_length > max_chars THEN
        output := substr(output, 1, max_chars) || chr(10) || U&'\\2026[' || to_char(original_length - max_chars, 'FM999,999,999,999,999,999,990') || ' more characters truncated]';
        result := jsonb_set(result, key_path, to_jsonb(output), false);
      END IF;
    END IF;
  END LOOP;
  RETURN result::text;
END $$;
CREATE OR REPLACE FUNCTION platform.json_valid(value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN PERFORM value::jsonb; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE OR REPLACE FUNCTION platform.json_extract(value text, path text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE result jsonb; BEGIN result := value::jsonb #> string_to_array(trim(leading '$.' from path), '.'); RETURN CASE WHEN result = 'true'::jsonb THEN '1' WHEN result = 'false'::jsonb THEN '0' ELSE result #>> '{}' END; END $$;
CREATE OR REPLACE FUNCTION platform.json_type(value text, path text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE jsonb_typeof(value::jsonb #> string_to_array(trim(leading '$.' from path), '.')) WHEN 'string' THEN 'text' WHEN 'number' THEN 'integer' ELSE jsonb_typeof(value::jsonb #> string_to_array(trim(leading '$.' from path), '.')) END $$;
CREATE OR REPLACE FUNCTION platform.json_each(value text, path text) RETURNS TABLE(key bigint, value text) LANGUAGE sql IMMUTABLE AS $$ SELECT ordinality - 1, item::text FROM jsonb_array_elements(value::jsonb #> string_to_array(trim(leading '$.' from path), '.')) WITH ORDINALITY AS a(item, ordinality) $$;
CREATE OR REPLACE FUNCTION platform.json_remove(value text, VARIADIC paths text[]) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE result jsonb := value::jsonb; p text; BEGIN FOREACH p IN ARRAY paths LOOP result := result #- string_to_array(trim(leading '$.' from p), '.'); END LOOP; RETURN result::text; END $$;
CREATE OR REPLACE FUNCTION platform.json_set(value text, path text, replacement text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_set(value::jsonb, string_to_array(trim(leading '$.' from path), '.'), coalesce(to_jsonb(replacement), 'null'::jsonb), true)::text $$;
CREATE OR REPLACE FUNCTION platform.instr(value text, part text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT strpos(value, part) $$;
CREATE OR REPLACE FUNCTION platform.printf(pattern text, value bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT to_char(value, 'FM999,999,999,999,999,999,990') $$;
CREATE OR REPLACE FUNCTION platform.json_replace(value text, VARIADIC pairs text[]) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$ DECLARE result jsonb := value::jsonb; path text[]; i integer; BEGIN FOR i IN 1..coalesce(array_length(pairs, 1), 0) BY 2 LOOP path := string_to_array(trim(leading '$.' from pairs[i]), '.'); IF result #> path IS NOT NULL THEN result := jsonb_set(result, path, coalesce(to_jsonb(pairs[i + 1]), 'null'::jsonb), false); END IF; END LOOP; RETURN result::text; END $$;
CREATE OR REPLACE FUNCTION platform.hyperfide_host_path_key(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN value ~ '^[a-zA-Z]:[\\\\/]' OR value LIKE E'\\\\\\\\%' THEN lower(replace(rtrim(value, E'/\\\\'), E'\\\\', '/') COLLATE "C.utf8") ELSE value END $$;
CREATE OR REPLACE FUNCTION platform.hyperfide_host_path_contains(root text, candidate text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN platform.hyperfide_host_path_key(candidate) = platform.hyperfide_host_path_key(root) OR starts_with(platform.hyperfide_host_path_key(candidate), platform.hyperfide_host_path_key(root) || '/') THEN 1 ELSE 0 END $$;
CREATE OR REPLACE FUNCTION platform.hyperfide_fts_match(value text, query text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT to_tsvector('simple', regexp_replace(regexp_replace(normalize(value, NFKD), U&'[\\0300-\\036f]', '', 'g') COLLATE "C.utf8", '[^[:alnum:]]+', ' ', 'g')) @@ to_tsquery('simple', replace(replace(regexp_replace(replace(regexp_replace(normalize(query, NFKD), U&'[\\0300-\\036f]', '', 'g'), '"', ''), '[*]', ':*', 'g'), ' AND ', ' & '), ' OR ', ' | ')) $$;
`;

export function portablePostgresSql(source: string): string {
  const query = /^\s*INSERT OR IGNORE\b/i.test(source)
    ? source
        .replace(/INSERT OR IGNORE/i, "INSERT")
        .replace(/;?\s*$/, " ON CONFLICT DO NOTHING")
    : source;
  return query
    .replace(/\bchar\(/gi, "chr(")
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(/\bINDEXED BY \w+/gi, "")
    .replace(/\bAS BLOB\b/gi, "AS bytea")
    .replace(/\browid\b/g, "ctid")
    .replace(/\bIS (\$\d+)/gi, "IS NOT DISTINCT FROM $1")
    .replace(/\bIS NOT ('(?:''|[^'])*'|\$\d+)/gi, "IS DISTINCT FROM $1")
    .replace(/\bIS ('(?:''|[^'])*')/gi, "IS NOT DISTINCT FROM $1")
    .replace(
      /thread_search_segments_fts MATCH (\$\d+)/g,
      "platform.hyperfide_fts_match(thread_search_segments_fts.text, $1)",
    )
    .replace(/isTitle = 1/g, "isTitle = true")
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\b[A-Za-z_]\w*\b/g, (token) =>
      /^[a-z_].*[A-Z]/.test(token) ? `"${token}"` : token,
    )
    .replace(/\bWHERE 0\b/g, "WHERE false")
    .replace(/\bWHERE 1\b/g, "WHERE true");
}
export function postgresPlaceholders(source: string): string {
  let index = 0;
  return source.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (token) =>
    token === "?" ? `$${++index}` : token,
  );
}
