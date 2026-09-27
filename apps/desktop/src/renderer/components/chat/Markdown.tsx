// Model answers as Markdown: GFM (tables, lists, code). Raw HTML is shown as text (react-markdown
// default), remote images are not loaded and links never navigate the app window.
import { Children, isValidElement, memo, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, useToast } from "@nova/ui";
import { fr } from "../../copy/fr";
import { useClient } from "../../state/context";
import { CheckIcon, CopyIcon } from "../icons";

type CopyState = "idle" | "copied" | "failed";

function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  const label = state === "copied" ? fr.app.copied : state === "failed" ? fr.chat.copyFailed : fr.chat.copyCode;
  return (
    <figure className="nova-code">
      <figcaption className="nova-code__bar">
        <span className="nova-code__language">{language ?? fr.chat.codePlain}</span>
        <Button
          variant="ghost"
          size="sm"
          icon={state === "copied" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          onClick={() => void copy()}
          aria-live="polite"
        >
          {label}
        </Button>
      </figcaption>
      <pre className="nova-code__pre">
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function ExternalLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const client = useClient();
  const toast = useToast();

  async function open(event: MouseEvent<HTMLAnchorElement>) {
    // Never navigate the app window: allowed https links go to the system browser, others are copied.
    event.preventDefault();
    if (!href) return;
    try {
      await client.app.openExternal({ url: href });
    } catch {
      let copied = false;
      try {
        await navigator.clipboard.writeText(href);
        copied = true;
      } catch {
        copied = false;
      }
      toast.show({
        title: fr.chat.linkRefused,
        description: copied ? fr.chat.linkCopied : href,
        tone: "info",
      });
    }
  }

  return (
    <a href={href} title={href} onClick={(event) => void open(event)} rel="noreferrer">
      {children}
    </a>
  );
}

function codeChild(children: ReactNode): { language: string | null; code: string } | null {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null;
  const language = /language-([\w+#.-]+)/.exec(child.props.className ?? "")?.[1] ?? null;
  const code = Children.toArray(child.props.children)
    .map((part) => (typeof part === "string" || typeof part === "number" ? String(part) : ""))
    .join("")
    .replace(/\n$/, "");
  return { language, code };
}

const components: Components = {
  pre({ children }) {
    const block = codeChild(children);
    return block ? <CodeBlock language={block.language} code={block.code} /> : <pre>{children}</pre>;
  },
  a({ href, children }) {
    return <ExternalLink href={href}>{children}</ExternalLink>;
  },
  img({ alt }) {
    // Remote images would leak the conversation to third parties (and the CSP blocks them anyway).
    return <span className="nova-md__image">{fr.chat.image(alt || fr.chat.imageNoAlt)}</span>;
  },
  table({ children }) {
    return (
      <div className="nova-md__table">
        <table>{children}</table>
      </div>
    );
  },
};

const remarkPlugins = [remarkGfm];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="nova-md">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
