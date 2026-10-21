export interface CommunityPost {
  id: string;
  authorWallet: string;
  authorName: string;
  title: string;
  body: string;
  category: string;
  strategyId: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  likeCount: number;
  replyCount: number;
  liked: boolean;
  bookmarked: boolean;
}
export interface CommunityReply {
  id: string;
  authorWallet: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface NotebookNote {
  id: string;
  title: string;
  body: string;
  strategyId: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface CommunityDraft {
  title: string;
  body: string;
  category: string;
  strategyId: string | null;
}
export interface CommunityAccount {
  wallet: string;
  profile: { displayName: string; bio: string };
  preferences: {
    defaultForumCategory: string;
    defaultForumSort: 'newest' | 'replies';
    savedStrategies: string[];
  };
  draft: CommunityDraft | null;
  notes: NotebookNote[];
  likedPosts: CommunityPost[];
  bookmarkedPosts: CommunityPost[];
  revision: number;
}
export interface StrategyPolicy {
  kind: 'BUY_AND_HOLD' | 'EMA_CROSS' | 'DCA';
  allocationBps: number;
  maxSlippageBps: number;
  fastPeriod?: number;
  slowPeriod?: number;
  intervalDays?: number;
}
export interface CreatorStrategy {
  id: string;
  authorWallet: string;
  name: string;
  symbol: 'TSLA' | 'AMZN';
  summary: string;
  method: string;
  risks: string;
  policy: StrategyPolicy;
  version: number;
  publishedVersion: number | null;
  publicationRevision: number;
  publishedAt: string | number | null;
  createdAt: string | number;
  updatedAt: string | number;
  status: 'DRAFT' | 'PUBLISHED' | 'UNLISTED';
  digest: string;
  executionStatus: 'DOCUMENT_ONLY';
}
export interface CommunityState {
  account: CommunityAccount | null;
  accountLoaded: boolean;
  posts: CommunityPost[];
  nextCursor: string | null;
  post: CommunityPost | null;
  replies: CommunityReply[];
  replyCursor: string | null;
  strategies: CreatorStrategy[];
  strategyCursor: string | null;
  ownedStrategies: CreatorStrategy[];
  strategy: CreatorStrategy | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
}
export const forumCategories = [
  'All',
  'Research Notes',
  'Strategy Discussion',
  'Build Logs',
  'Workshop Proposals',
];
