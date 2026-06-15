let loadPromise: Promise<void> | null = null;

export function loadHackFont(): Promise<void> {
	if (loadPromise) return loadPromise;
	loadPromise = (async () => {
		const faces = [
			new FontFace("Hack", "url('/fonts/hacknerdmono-regular.ttf')", { weight: "400", style: "normal" }),
			new FontFace("Hack", "url('/fonts/hacknerdmono-bold.ttf')", { weight: "700", style: "normal" }),
			new FontFace("Hack", "url('/fonts/hacknerdmono-italic.ttf')", { weight: "400", style: "italic" }),
			new FontFace("Hack", "url('/fonts/hacknerdmono-bolditalic.ttf')", { weight: "700", style: "italic" }),
		];
		const loaded = await Promise.allSettled(faces.map((f) => f.load()));
		for (const result of loaded) {
			if (result.status === "fulfilled") {
				document.fonts.add(result.value);
			}
		}
	})();
	return loadPromise;
}
