import {
  ProjectSourceDeleteDialogContent,
  type ProjectSourceDeleteDialogTarget,
} from "./ProjectSourceDeleteDialog";
import { HOST_NAMES } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Project Source Delete",
};

const noop = () => {};

const localHostTarget: ProjectSourceDeleteDialogTarget = {
  id: "src_local",
  label: HOST_NAMES.local,
};

const longTarget: ProjectSourceDeleteDialogTarget = {
  id: "src_long",
  label:
    "/Users/michael/projects/internal-tooling-ingest-pipeline-rewrite-2026",
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="local source"
        hint="local_path source — label is the host name"
      >
        <DialogStage>
          <ProjectSourceDeleteDialogContent
            target={localHostTarget}
            pending={false}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="long label"
        hint="long local path expands inline inside the description"
      >
        <DialogStage>
          <ProjectSourceDeleteDialogContent
            target={longTarget}
            pending={false}
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow label="pending" hint="destructive button disabled">
        <DialogStage>
          <ProjectSourceDeleteDialogContent
            target={localHostTarget}
            pending
            onDelete={noop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
