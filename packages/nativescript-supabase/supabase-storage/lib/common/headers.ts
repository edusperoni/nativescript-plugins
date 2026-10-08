export function setHeader(headers: Record<string, string>, name: string, value: string): Record<string, string> {
	const result = { ...headers };
	const nameLower = name.toLowerCase();

	for (const key of Object.keys(result)) {
		if (key.toLowerCase() === nameLower) {
			delete result[key];
		}
	}

	result[nameLower] = value;
	return result;
}

export function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		result[key.toLowerCase()] = value;
	}
	return result;
}
