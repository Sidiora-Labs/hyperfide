export interface PathChangeEvent {
  changedPaths: string[];
}

export type PathChangeCallback = (event: PathChangeEvent) => void;

export interface PathChangeWatchError {
  message: string;
  rootPath: string;
}

export type PathChangeWatchErrorCallback = (
  error: PathChangeWatchError,
) => void;

export interface PathChangeWatchArgs {
  onChange: PathChangeCallback;
  onWatchError: PathChangeWatchErrorCallback;
}
