import { useMemo } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { EDITOR_FILE_URL_SCHEMES } from "./markdown-local-file-link.js";

type MarkdownRehypePlugins = NonNullable<Options["rehypePlugins"]>;

const MARKDOWN_HTML_REHYPE_PLUGINS: MarkdownRehypePlugins = [
  rehypeRaw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      tagNames: [
        ...(defaultSchema.tagNames ?? []),
        "video",
        "hyperfide-thread-mention",
        "hyperfide-prompt-mention",
        "hyperfide-message-directive",
      ],
      protocols: {
        ...defaultSchema.protocols,
        href: [
          ...(defaultSchema.protocols?.href ?? []),
          ...EDITOR_FILE_URL_SCHEMES,
        ],
        poster: ["http", "https"],
      },
      attributes: {
        ...defaultSchema.attributes,
        source: [
          ...(defaultSchema.attributes?.source ?? []),
          "src",
          "type",
          "media",
        ],
        video: [
          "src",
          "controls",
          "playsInline",
          "preload",
          "poster",
          "width",
          "height",
          "title",
          "ariaLabel",
        ],
        code: [
          ...(defaultSchema.attributes?.code ?? []),
          "dataCodeFenceOffset",
          "dataCodeFenceClosed",
        ],
        "hyperfide-thread-mention": [
          "dataThreadId",
          "dataRawThreadId",
          "dataRawThreadInlineCode",
        ],
        "hyperfide-prompt-mention": ["dataMentionIndex"],
        "hyperfide-message-directive": ["dataDirectiveIndex"],
      },
    },
  ],
];

export function MarkdownHtml({ rehypePlugins, ...props }: Options) {
  const plugins = useMemo(
    () => [...MARKDOWN_HTML_REHYPE_PLUGINS, ...(rehypePlugins ?? [])],
    [rehypePlugins],
  );
  return <ReactMarkdown {...props} rehypePlugins={plugins} />;
}
