import forums from '../lists/forums.json';
import gaming from '../lists/gaming.json';
import mail from '../lists/mail.json';
import news from '../lists/news.json';
import shopping from '../lists/shopping.json';
import social from '../lists/social.json';
import video from '../lists/video.json';
import type { CategoryList } from '../shared/types';

/** Bundled category lists, options UI order. */
export const ALL_CATEGORIES: CategoryList[] = [
  social,
  video,
  news,
  mail,
  shopping,
  gaming,
  forums,
] as CategoryList[];
