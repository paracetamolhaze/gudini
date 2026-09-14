/** Shapes returned by the Threads Graph API, narrowed to the fields this service asks for. */

export interface ThreadsProfile {
  id: string;
  username: string;
  name?: string;
  threads_profile_picture_url?: string;
  threads_biography?: string;
  is_verified?: boolean;
}

export interface ThreadsMediaChild {
  id?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  alt_text?: string;
}

export interface ThreadsMedia {
  id: string;
  text?: string;
  username?: string;
  permalink?: string;
  timestamp?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  shortcode?: string;
  is_quote_post?: boolean;
  is_reply?: boolean;
  has_replies?: boolean;
  replied_to?: { id?: string };
  root_post?: { id?: string };
  quoted_post?: { id?: string; text?: string; username?: string };
  reposted_post?: { id?: string; text?: string; username?: string };
  link_attachment_url?: string;
  topic_tag?: string;
  alt_text?: string;
  hide_status?: string;
  children?: { data?: ThreadsMediaChild[] };
  owner?: { id?: string; username?: string };
}

export interface Paged<T> {
  data: T[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string };
}

export interface PublishingLimit {
  quota_usage: number;
  config: { quota_total: number; quota_duration: number };
  reply_quota_usage: number;
  reply_config: { quota_total: number; quota_duration: number };
}

export interface PostInsights {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  shares: number;
}

export interface PublicProfileLookup {
  username: string;
  name?: string;
  profile_picture_url?: string;
  biography?: string;
  follower_count?: number;
  likes_count?: number;
  quotes_count?: number;
  reposts_count?: number;
  views_count?: number;
  is_verified?: boolean;
}

export type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export type ReplyControl = "everyone" | "accounts_you_follow" | "mentioned_only" | "parent_post_author_only" | "followers_only";

export interface CreateContainerParams {
  media_type: "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL";
  text?: string;
  image_url?: string;
  video_url?: string;
  alt_text?: string;
  reply_to_id?: string;
  quote_post_id?: string;
  reply_control?: ReplyControl;
  link_attachment?: string;
  topic_tag?: string;
  is_carousel_item?: boolean;
  children?: string[];
}

/** Fields worth asking for on any post. Kept in one place so they cannot drift. */
export const POST_FIELDS =
  "id,text,permalink,timestamp,media_type,media_url,thumbnail_url,username,shortcode,is_quote_post,has_replies,quoted_post,reposted_post,link_attachment_url,topic_tag,alt_text,children{id,media_type,media_url,thumbnail_url,alt_text}";

export const REPLY_FIELDS =
  "id,text,username,permalink,timestamp,media_type,media_url,thumbnail_url,shortcode,is_reply,replied_to,root_post,has_replies,hide_status,children{id,media_type,media_url,thumbnail_url}";

export const MENTION_FIELDS =
  "id,text,username,timestamp,permalink,shortcode,media_type,media_url,thumbnail_url,is_reply,owner{id,username},children{id,media_type,media_url,thumbnail_url}";

/** Image URLs (thumbnails first) of a media object, capped so vision prompts stay small. */
export function mediaImageUrls(m: ThreadsMedia, max = 4): string[] {
  const urls: string[] = [];
  const push = (u?: string) => {
    const s = typeof u === "string" ? u.trim() : "";
    if (s && /^https?:\/\//i.test(s) && !urls.includes(s)) urls.push(s);
  };
  if (m.media_type === "IMAGE") push(m.media_url);
  if (m.media_type === "VIDEO") push(m.thumbnail_url);
  for (const c of m.children?.data ?? []) {
    if (c.media_type === "IMAGE") push(c.media_url);
    else push(c.thumbnail_url);
  }
  // Fallback for objects without media_type in the response.
  push(m.media_url);
  push(m.thumbnail_url);
  return urls.slice(0, max);
}
