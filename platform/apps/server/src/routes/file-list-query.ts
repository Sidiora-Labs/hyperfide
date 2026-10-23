import { FILE_LIST_LIMIT_MAX } from "@bb/server-contract";
import { parseBoundedPositiveOptionalInteger } from "../services/lib/validation.js";

const FILE_LIST_LIMIT_DEFAULT = 1000;

export function parseFileListLimit(limit: string | undefined): number {
  return parseBoundedPositiveOptionalInteger({
    defaultValue: FILE_LIST_LIMIT_DEFAULT,
    max: FILE_LIST_LIMIT_MAX,
    name: "limit",
    value: limit,
  });
}
