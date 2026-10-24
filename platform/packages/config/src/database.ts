import {
  loadCommonConfig,
  type CommonConfig,
  type LoadCommonConfigArgs,
} from "./common.js";
import { resolveDataDirDatabasePath } from "./runtime.js";

export interface DatabaseConfig {
  databasePath: string;
}

interface LoadDatabaseConfigArgs extends LoadCommonConfigArgs {
  commonConfig?: CommonConfig;
}

export function loadDatabaseConfig(
  args: LoadDatabaseConfigArgs = {},
): DatabaseConfig {
  const commonConfig = args.commonConfig ?? loadCommonConfig(args);
  return {
    databasePath:
      (args.env ?? process.env).HYPERFIDE_DATABASE_URL ??
      resolveDataDirDatabasePath({
        dataDir: commonConfig.HYPERFIDE_DATA_DIR,
      }),
  };
}
