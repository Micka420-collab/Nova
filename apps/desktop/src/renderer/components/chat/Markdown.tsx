// Model answers as Markdown: GFM (tables, lists, code). Raw HTML is shown as text (react-markdown
// default), remote images are not loaded and links never navigate the app window.
import {
  Children,
  createContext,
  isValidElement,
  memo,
  use,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, Callout } from "@nova/ui";
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

/** Reports a link main refused to open, to the answer that contains it. */
const RefusedLinkContext = createContext<(href: string) => void>(() => undefined);

/** Scheme and host, the part that says where a link really goes; null when `href` is not absolute. */
function linkOrigin(href: string): string | null {
  try {
    const url = new URL(href);
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    return null;
  }
}

/** In-document anchors (footnotes) scroll within the answer that holds them; ids repeat across answers. */
function scrollToAnchor(link: HTMLElement, fragment: string) {
  let id: string;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    return;
  }
  const root = link.closest(".nova-md") ?? document;
  const target = [...root.querySelectorAll<HTMLElement>("[id]")].find((element) => element.id === id);
  target?.scrollIntoView({ block: "nearest" });
}

/**
 * A refused link is never copied behind the user's back: its real destination is shown (the link
 * text may say something else) and copying it is an explicit choice.
 */
export function RefusedLink({ href, onDismiss }: { href: string; onDismiss: () => void }) {
  const [state, setState] = useState<CopyState>("idle");
  const origin = linkOrigin(href);

  async function copy() {
    try {
      await navigator.clipboard.writeText(href);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  const label = state === "copied" ? fr.chat.linkCopied : state === "failed" ? fr.chat.copyFailed : fr.chat.linkCopy;
  return (
    <Callout
      tone="warning"
      className="nova-md__refused"
      title={fr.chat.linkRefused}
      action={
        <div className="nova-message__actions">
          <Button size="sm" variant="secondary" icon={<CopyIcon size={14} />} onClick={() => void copy()} aria-live="polite">
            {label}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {fr.chat.linkDismiss}
          </Button>
        </div>
      }
    >
      <p>{fr.chat.linkRefusedBody}</p>
      {origin ? <p className="nova-md__refused-origin">{origin}</p> : null}
      <p>
        {fr.chat.linkDestination} : <code className="nova-md__refused-url">{href}</code>
      </p>
    </Callout>
  );
}

function ExternalLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const client = useClient();
  const onRefused = use(RefusedLinkContext);

  async function open(event: MouseEvent<HTMLAnchorElement>) {
    // Never navigate the app window: allowed https links go to the system browser.
    event.preventDefault();
    if (!href) return;
    if (href.startsWith("#")) {
      scrollToAnchor(event.currentTarget, href.slice(1));
      return;
    }
    try {
      await client.app.openExternal({ url: href });
    } catch {
      onRefused(href);
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
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <div className="nova-md">
      <RefusedLinkContext value={setRefused}>
        <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
          {text}
        </ReactMarkdown>
      </RefusedLinkContext>
      {refused ? <RefusedLink key={refused} href={refused} onDismiss={() => setRefused(null)} /> : null}
    </div>
  );
});
