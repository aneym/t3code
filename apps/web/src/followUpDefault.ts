import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";

export const FOLLOW_UP_UNCHOSEN = {
  followUpBehavior: DEFAULT_CLIENT_SETTINGS.followUpBehavior,
  followUpBehaviorChosen: false,
};

export const chooseFollowUp = (followUpBehavior: ClientSettings["followUpBehavior"]) => ({
  followUpBehavior,
  followUpBehaviorChosen: true,
});

export const withFollowUpDefault = (settings: ClientSettings): ClientSettings =>
  settings.followUpBehaviorChosen ? settings : { ...settings, ...FOLLOW_UP_UNCHOSEN };
