
import { cn } from "@/lib/cn";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { useStore } from "@/state/store";

import { useWorkspacePlace, type WorkspacePlace } from "./DesktopWorkspaceSwitcher";
import { SidebarConnectApps } from "./SidebarConnectApps";
import { SidebarBottomButtons, SidebarFooterNav } from "./SidebarFooterNav";
import { SidebarProfileMenu, useSimpleAccount, type ArchivedBots } from "./SidebarProfileMenu";

export function useSimplePlace(): WorkspacePlace {
  const { state } = useStore();
  return useWorkspacePlace({ cloudHome: state.config?.cloudHome === true });
}

export function SidebarPlaceStatus({ place, className }: { place: WorkspacePlace; className?: string }) {
  if (place.error) return <p role="alert" className={cn("text-[12px] text-danger", className)}>{place.error}</p>;
  return null;
}

function SimpleSidebarFooter({ owner, archived }: { owner: string | null; archived?: ArchivedBots }) {
  const place = useSimplePlace();
  const account = useSimpleAccount(place, owner, archived);
  return (
    <div data-sidebar-footer="simple" className="px-4 pb-4 pt-2">
      <SidebarPlaceStatus place={place} className="mb-2 px-1" />
      <div className="flex items-center gap-2 not-first:mt-2">
        <SidebarProfileMenu simple={account} />
        <SidebarConnectApps />
      </div>
    </div>
  );
}

export function SidebarFooter({ density, simple = false, owner = null, archived, toolsCollapsed, onToggleTools }: {
  density: SidebarDensity;
  simple?: boolean;
  owner?: string | null;
  archived?: ArchivedBots;
  toolsCollapsed: boolean;
  onToggleTools?: () => void;
}) {
  if (simple) return <SimpleSidebarFooter owner={owner} archived={archived} />;
  return (
    <div className={cn("pb-3 pt-2", density === "icons" ? "flex flex-col items-center gap-1 px-2" : "px-3")}>
      <SidebarFooterNav density={density} collapsed={toolsCollapsed} onToggleCollapsed={onToggleTools} />
      {density === "icons" ? (
        <>
          <div className="flex flex-col items-center justify-center gap-1">
            <SidebarProfileMenu iconOnly />
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-1 not-first:mt-3">
            <div className="min-w-0 flex-1">
              <SidebarProfileMenu />
            </div>
            <SidebarBottomButtons />
          </div>
        </>
      )}
    </div>
  );
}
