import type { CtaPlacement } from "./site";

type LandingEvent =
  | {
      name: "landing_github_clicked";
      properties: { placement: CtaPlacement };
    }
  | {
      name: "landing_discord_clicked";
      properties: { placement: CtaPlacement };
    }
  | {
      name: "landing_x_clicked";
      properties: { placement: CtaPlacement };
    }
  | {
      name: "landing_cli_command_copied";
      properties: { placement: CtaPlacement; command: string };
    }
  | {
      name: "landing_send_to_computer_clicked";
      properties: { placement: CtaPlacement };
    }
  | {
      name: "guide_prompt_copied";
      properties: {
        guide: string;
        placement: "hero" | "handoff" | "step";
      };
    }
  | {
      name: "landing_email_subscribed";
      properties: { placement: CtaPlacement };
    }
  | {
      name: "marketplace_page_viewed";
      properties: {
        category?: string;
        sort: "featured" | "recently-added" | "most-installed";
        author?: string;
      };
    }
  | {
      name: "marketplace_plugin_detail_viewed";
      properties: { plugin_id: string };
    }
  | {
      name: "marketplace_install_command_copied";
      properties: { plugin_id: string };
    };

export function initAnalytics(): void {}
export function useInitAnalytics(): void {}
export function trackLandingEvent(event: LandingEvent): void {
  console.debug("Local event", event);
}
