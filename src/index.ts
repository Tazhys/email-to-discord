
/**
 * Helper function to decode common Content-Transfer-Encoding types.
 * This is a simplified implementation and might not cover all edge cases
 * of quoted-printable or base64 (e.g., malformed encoding).
 */
function decodeContent(encodedText: string, transferEncoding?: string): string {
	if (!encodedText) return "";
	const encoding = transferEncoding ? transferEncoding.toLowerCase() : "";
	if (encoding === "base64") {
		try {
			return atob(encodedText.replace(/\s/g, ""));
		} catch (e) {
			console.warn("Base64 decoding failed:", e);
			return encodedText;
		}
	} else if (encoding === "quoted-printable") {
		return encodedText
			.replace(/=\r\n/g, "")
			.replace(/=([0-9A-Fa-f]{2})/g, (match, p1) =>
				String.fromCharCode(parseInt(p1, 16)),
			);
	} else {
		return encodedText;
	}
}

/**
 * Parses the raw email content to extract the plain text body.
 * Prioritizes text/plain over text/html, and strips HTML if only HTML is available.
 */
async function extractEmailBody(rawEmailContent: string): Promise<string> {
	let plainTextBody = "";
	let htmlBody = "";

	const bodySeparatorIndex = rawEmailContent.indexOf("\r\n\r\n");
	if (bodySeparatorIndex === -1) {
		return rawEmailContent.trim();
	}

	const initialHeaders = rawEmailContent.substring(0, bodySeparatorIndex);
	const rawBodyContent = rawEmailContent.substring(bodySeparatorIndex + 4);

	const contentTypeHeaderMatch = initialHeaders.match(
		/^Content-Type:\s*multipart\/[a-zA-Z0-9._-]+;\s*boundary="?([^"\s]+)"?/im,
	);

	if (contentTypeHeaderMatch && rawBodyContent) {
		const boundary = contentTypeHeaderMatch[1];
		const boundaryRegex = new RegExp(`(?:\\r\\n)?--${boundary}(?:--)?(?:\\r\\n)?`, "g");
		const parts = rawBodyContent.split(boundaryRegex);
		for (const part of parts) {
			if (!part.trim()) continue;
			const partHeadersEnd = part.indexOf("\r\n\r\n");
			if (partHeadersEnd === -1) continue;
			const partHeaders = part.substring(0, partHeadersEnd);
			const partBody = part.substring(partHeadersEnd + 4);
			const partContentTypeMatch = partHeaders.match(/Content-Type:\s*([^;]+)(?:;\s*charset="?([^"\s]+)"?)?/im);
			const partTransferEncodingMatch = partHeaders.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/im);
			let contentType = partContentTypeMatch ? partContentTypeMatch[1].toLowerCase() : "";
			let transferEncoding = partTransferEncodingMatch ? partTransferEncodingMatch[1].toLowerCase() : "";
			if (contentType.includes("text/plain")) {
				plainTextBody = decodeContent(partBody, transferEncoding);
				break;
			} else if (contentType.includes("text/html")) {
				htmlBody = decodeContent(partBody, transferEncoding);
			}
		}
	} else {
		const transferEncodingMatch = initialHeaders.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/im);
		const transferEncoding = transferEncodingMatch ? transferEncodingMatch[1].toLowerCase() : "";
		plainTextBody = decodeContent(rawBodyContent, transferEncoding);
	}
	if (plainTextBody.trim()) {
		return plainTextBody.trim();
	} else if (htmlBody.trim()) {
		return htmlBody.replace(/<[^>]*>?/gm, " ").trim();
	}
	return "";
}

interface Env {
	DISCORD_BOT_TOKEN: string;
	DISCORD_CHANNEL_ID: string;
}

export default {
	async email(message: any, env: Env, ctx: any) {
		const BOT_TOKEN = env.DISCORD_BOT_TOKEN;
		const CHANNEL_ID = env.DISCORD_CHANNEL_ID;

		if (!BOT_TOKEN || !CHANNEL_ID) {
			console.error("Missing Discord BOT_TOKEN or CHANNEL_ID environment variables. Please set them as secrets in your Cloudflare Worker settings.");
			return;
		}

		const subject = message.headers.get("Subject") || "No Subject";
		const from = message.headers.get("From") || "Unknown Sender";
		const to = message.headers.get("To") || "Unknown Recipient";
		let emailBodySnippet = "Could not retrieve email body.";
		let rawEmailContent = "";
		try {
			rawEmailContent = await new Response(message.raw).text();
			const extractedBody = await extractEmailBody(rawEmailContent);
			if (extractedBody) {
				emailBodySnippet = extractedBody.slice(0, 500);
				if (extractedBody.length > 500) {
					emailBodySnippet += "...\n\n(Full message truncated)";
				}
			} else {
				const fallbackStartIndex = rawEmailContent.indexOf("\r\n\r\n");
				if (fallbackStartIndex !== -1) {
					let rawBodyFallback = rawEmailContent.substring(fallbackStartIndex + 4).trim();
					emailBodySnippet = `(Could not parse main body, showing raw snippet):\n\n${rawBodyFallback.slice(0, 200)}...\n`;
				} else {
					emailBodySnippet = "Could not parse email body (no content after headers).";
				}
			}
		} catch (error: any) {
			console.error("Error during email body extraction:", error);
			emailBodySnippet = `Error processing email body: ${error.message}\n\nRaw Email Start:\n${rawEmailContent.slice(0, 200)}...\n`;
		}

		const payload = {
			"components": [{
				"type": 17,
				"components": [{
					"type": 10,
					"content": `Subject: ${subject}\nFrom: ${from}\nTo: ${to}`
				}, {
					"type": 14,
					"spacing": 1,
					"divider": true
				}, {
					"type": 10,
					"content": emailBodySnippet
				}]
			}],
			"flags": 32768,
		};
		const discordApiUrl = `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`;
		try {
			const response = await fetch(discordApiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bot ${BOT_TOKEN}`
				},
				body: JSON.stringify(payload),
			});
			if (!response.ok) {
				const errorDetails = await response.text();
				console.error(
					`Failed to send Discord message: ${response.status} ${response.statusText} - ${errorDetails}`
				);
				throw new Error(
					`Discord API failed: ${response.status} ${response.statusText} - ${errorDetails}`
				);
			} else {
				console.log("Email successfully sent to Discord via bot token.");
			}
		} catch (error) {
			console.error("Error sending message to Discord:", error);
			throw error;
		}
	},
};
