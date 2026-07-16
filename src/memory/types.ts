export interface SharedMemoryEntry {
	id: string;
	title: string;
	content: string;
	tags: string[];
	pinned: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SharedMemoryUpsertInput {
	id?: string;
	title: string;
	content: string;
	tags?: string[];
	pinned?: boolean;
}

export interface SharedMemoryPromptContext {
	text: string;
	entryCount: number;
	entryIds: string[];
	estimatedTokens: number;
}

export interface SharedMemoryContextProvider {
	buildPromptContext(query: string, maxTokens: number): Promise<SharedMemoryPromptContext | undefined>;
}
