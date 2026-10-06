import { feedRows, type FeedFilter, type LiveFeed } from "./live.js";
import { fit, style } from "./layout.js";

/** Activity stays in memory. Newest rows remain visible within the allocated region. */
export function activityRows(feed: LiveFeed, filter: FeedFilter, width: number, height: number): string[] {
	return (height <= 0 ? [] : feedRows(feed, filter).slice(-height)).map((row) => fit(` ${row}`, width));
}
export const activityTitle = (filter: FeedFilter): string => `${style.bold("Activity")} · ${filter}`;
