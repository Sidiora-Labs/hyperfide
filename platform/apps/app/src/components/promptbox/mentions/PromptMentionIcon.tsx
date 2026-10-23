import type { PromptMentionResource } from "@hyperfide/domain";
import type { ComposerMentionTargetShape } from "@hyperfide/client-core";
import { Icon } from "@hyperfide/shared-ui/icon";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import { promptMentionIconName } from "@hyperfide/client-core";
import { composerMentionResource } from "./prompt-mention-pill";

export function PromptMentionIcon({
  className,
  resource,
}: {
  className?: string;
  resource: PromptMentionResource;
}) {
  if (resource.kind === "plugin") {
    return (
      <PluginItemIcon
        pluginId={resource.pluginId}
        icon={resource.icon ?? null}
        className={className}
      />
    );
  }
  return (
    <Icon
      name={promptMentionIconName(resource)}
      className={className}
      aria-hidden
    />
  );
}

export function ComposerMentionIcon({
  mention,
  className,
}: {
  mention: ComposerMentionTargetShape;
  className?: string;
}) {
  return (
    <PromptMentionIcon
      resource={composerMentionResource(mention)}
      {...(className === undefined ? {} : { className })}
    />
  );
}
