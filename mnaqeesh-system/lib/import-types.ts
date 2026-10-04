/** A row normalised for insertion into `public.posts`. */
export type SavedPostInput = {
  postKey: string;
  author: string;
  postDate: string;
  postTime: string;
  privacy: string;
  text: string;
  markdownText: string;
  imageUrls: string[];
  imageDirectUrls: string[];
  videoUrl: string;
  videoDirectUrl: string;
  postUrl: string;
  savedAt: string | null;
};
