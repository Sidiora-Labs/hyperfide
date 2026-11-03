export const NATIVE_SOURCE_ENVIRONMENT_ID = "hyperfide-native-source";
export interface NativeSliceInput { sourceConfigFile: string; workspaceId: string; mode: "SPARSE" | "MATERIALIZED" | "VIRTUAL"; readPaths?: string[] }
