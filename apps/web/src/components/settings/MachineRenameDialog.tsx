import { useState, type FormEvent, type RefObject } from "react";
import type { Host } from "@hyperfide/domain";
import { Button } from "@hyperfide/shared-ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hyperfide/shared-ui/dialog";
import { Input } from "@hyperfide/shared-ui/input";
import { RenameDialog } from "@hyperfide/shared-ui/rename-dialog";

const HOST_NAME_MAX_LENGTH = 100;

interface MachineRenameDialogProps {
  target: Host | null;
  pending: boolean;
  errorMessage: string | null;
  onOpenChange: (open: boolean) => void;
  onRename: (host: Host, name: string) => void;
}

export function MachineRenameDialog({
  target,
  pending,
  errorMessage,
  onOpenChange,
  onRename,
}: MachineRenameDialogProps) {
  return (
    <RenameDialog open={target !== null} onOpenChange={onOpenChange}>
      {(inputRef) =>
        target ? (
          <MachineRenameDialogContent
            key={target.id}
            target={target}
            pending={pending}
            errorMessage={errorMessage}
            onRename={onRename}
            inputRef={inputRef}
          />
        ) : null
      }
    </RenameDialog>
  );
}

function MachineRenameDialogContent({
  target,
  pending,
  errorMessage,
  onRename,
  inputRef,
}: {
  target: Host;
  pending: boolean;
  errorMessage: string | null;
  onRename: (host: Host, name: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [nextName, setNextName] = useState(target.name);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const trimmed = nextName.trim();
    if (trimmed.length === 0) return;
    onRename(target, trimmed);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename machine</DialogTitle>
        <DialogDescription>
          Choose a new name for {target.name}.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Input
            ref={inputRef}
            aria-label="Machine name"
            value={nextName}
            maxLength={HOST_NAME_MAX_LENGTH}
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => setNextName(event.target.value)}
          />
          {errorMessage !== null ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="submit"
            disabled={pending || nextName.trim().length === 0}
          >
            Rename machine
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
