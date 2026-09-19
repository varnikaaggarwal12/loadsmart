/**
 * lib/brokerDocReview.js
 *
 * Advisory AI Document Review for Broker GST/MSME uploads (spec section 9).
 * Reuses the exact same Anthropic vision integration pattern already used
 * for the POD AI Vision Check (lib/aiService.js's completeVision +
 * completeJson) — no new provider integration, no second AI plumbing.
 *
 * Hard rules enforced here:
 *  - This is ADVISORY ONLY. Nothing in this module ever writes kycStatus,
 *    approves, or rejects an account — it only produces a structured
 *    opinion for a human admin to read alongside the document.
 *  - Never logs the document's image bytes or the API key.
 *  - PDFs: completeVision only accepts an image media type. When the
 *    uploaded file is a PDF, this module skips the AI call entirely and
 *    returns a clear, honest "cannot process PDF" advisory result rather
 *    than pretending to have reviewed it.
 *  - Fails soft: any AI error (not configured, timeout, provider error)
 *    produces a result with looksReadable/looksLikeExpectedDocument left
 *    null and a plain-language note — never throws into the upload flow.
 */

const aiService = require('./aiService');

const DOCUMENT_LABELS = {
  GST: 'a GST (Goods and Services Tax) registration certificate',
  MSME: 'an MSME/Udyam registration certificate',
  PAN: 'a PAN (Permanent Account Number) card',
};

/**
 * @param {{documentType:'GST'|'MSME'|'PAN', imageBase64DataUrl:string}} args
 *   imageBase64DataUrl: a "data:image/...;base64,...." string — exactly
 *   what /api/kyc/upload already validates and stores.
 * @returns {Promise<object>} the advisory result shape from spec section 9,
 *   ALWAYS resolved (never rejected) so a failed AI call can never block or
 *   fail the underlying document upload.
 */
async function reviewBrokerDocument({ documentType, imageBase64DataUrl }) {
  const base = {
    documentType,
    looksReadable: null,
    looksLikeExpectedDocument: null,
    confidence: 0,
    concerns: [],
    summary: '',
    reviewedAt: new Date(),
  };

  const match = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(imageBase64DataUrl || '');
  if (!match) {
    return {
      ...base,
      summary: 'This document is a PDF (or an unrecognized format) — the AI vision reviewer can only look at image files (JPG/PNG), so no automated advisory review was performed. Admin should review the file directly.',
      concerns: ['AI review skipped — PDF/unsupported format.'],
    };
  }

  if (!aiService.isConfigured()) {
    return {
      ...base,
      summary: 'AI document review is not configured on this server right now — this document was uploaded normally and is waiting for manual admin review.',
      concerns: ['AI review unavailable — not configured.'],
    };
  }

  const mediaType = match[1] === 'png' ? 'image/png' : 'image/jpeg';
  const label = DOCUMENT_LABELS[documentType] || `a ${documentType} document`;
  const prompt = `You are looking at a document a user uploaded, claiming it is ${label}.
Look ONLY at what is visible in the image. Answer as strict JSON with this exact shape:
{"looksReadable": true|false, "looksLikeExpectedDocument": true|false, "confidence": 0.0-1.0, "concerns": ["short phrase", ...], "summary": "one or two plain sentences"}
Concerns should flag things like: blurry/dark/incomplete image, cropped/obscured fields, or the document appearing to be a different type of document than expected. Do not invent details you cannot see. This is an ADVISORY check only — you are not performing official government verification.`;

  try {
    const raw = await aiService.completeVision({
      system: 'You are a careful, literal document-appearance checker. You only describe what is visibly present — you never verify authenticity with an external registry, and you say so if asked.',
      prompt,
      imageBase64: match[2],
      mediaType,
      maxTokens: 400,
    });
    const cleaned = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      return {
        ...base,
        summary: 'The AI reviewer returned an unexpected response — this document is waiting for manual admin review.',
        concerns: ['AI review returned an unparseable response.'],
      };
    }
    return {
      ...base,
      looksReadable: parsed.looksReadable === true,
      looksLikeExpectedDocument: parsed.looksLikeExpectedDocument === true,
      confidence: Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0,
      concerns: Array.isArray(parsed.concerns) ? parsed.concerns.slice(0, 10).map((c) => String(c).slice(0, 200)) : [],
      summary: String(parsed.summary || '').slice(0, 600) || 'The document was reviewed by AI for readability and document type only. This is advisory, not official verification.',
    };
  } catch (err) {
    // Fail soft — never let an AI outage block or fail a document upload.
    return {
      ...base,
      summary: `AI document review could not be completed right now (${err.code === 'AI_NOT_CONFIGURED' ? 'AI not configured' : 'temporary error'}) — this document is waiting for manual admin review.`,
      concerns: ['AI review failed — see admin manual review.'],
    };
  }
}

module.exports = { reviewBrokerDocument, DOCUMENT_LABELS };
