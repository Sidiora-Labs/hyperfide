import {
  useInlineRename,
  useRenameController,
  type InlineRenameArgs,
  type InlineRenameEditorProps,
} from "@hyperfide/shared-ui/inline-rename";
import { defineSplit } from "@/lib/define-split";

const InlineRenameEditor = defineSplit<InlineRenameEditorProps>({
  id: "sidebar-rename-editor",
  load: () =>
    import("@hyperfide/shared-ui/inline-rename-editor").then(
      (module) => module.InlineRenameEditor,
    ),
  loading: ({ session }) => (
    <span role="status" className="min-w-0 flex-1 truncate">
      {session.name}
    </span>
  ),
  tier: "intent",
});

export function useSidebarRename(args: InlineRenameArgs) {
  const controller = useRenameController();
  return useInlineRename(args, {
    controller,
    Editor: InlineRenameEditor,
    fitEditorToContent: true,
  });
}
