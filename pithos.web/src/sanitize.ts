const DIRECTION_AND_FORMATTING_CONTROLS = /[\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
const DIRECTION_AND_FORMATTING_CONTROLS_TEST = /[\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

export function hasUnicodeFormattingControls(text: string): boolean {
	return DIRECTION_AND_FORMATTING_CONTROLS_TEST.test(text);
}

export function revealUnicodeFormattingControls(text: string): string {
	return text.replace(DIRECTION_AND_FORMATTING_CONTROLS, (character) => {
		const codePoint = character.codePointAt(0)!;
		return `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`;
	});
}
