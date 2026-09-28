// Extensions document (VISUAL.md §4.7): MCP servers and skills (J2-B L3), one section at a time.
import { Tabs, tabPanelProps } from "@nova/ui";
import { fr } from "../../copy/fr";
import { useApp } from "../../state/context";
import { SkillsManager } from "../skills/SkillsManager";
import { McpManager } from "./McpManager";

const copy = fr.atelier.shell;
const ID_PREFIX = "ext";

export function ExtensionsDoc() {
  const tab = useApp((state) => state.ui.extensionsTab);
  const setUi = useApp((state) => state.setUi);
  return (
    <div className="nova-extensions">
      <Tabs
        label={copy.extensionsTabs}
        idPrefix={ID_PREFIX}
        items={[
          { key: "mcp", label: copy.mcpTab },
          { key: "skills", label: copy.skillsTab },
        ]}
        activeKey={tab}
        onSelect={(key) => setUi({ extensionsTab: key === "skills" ? "skills" : "mcp" })}
      />
      <div {...tabPanelProps(ID_PREFIX, tab)} className="nova-extensions__panel">
        {tab === "skills" ? <SkillsManager /> : <McpManager />}
      </div>
    </div>
  );
}
