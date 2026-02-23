import fs from 'node:fs';

export interface UploadOptions {
  baseUrl: string;
  apiKey: string;
  agentCodeName: string;
  defenseScore: number;
  pdfPath: string;
}

interface PresignedResponse {
  upload_url: string;
  key: string;
  expires_in: number;
}

export async function uploadPdfReport(opts: UploadOptions): Promise<string> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/agents/${encodeURIComponent(opts.agentCodeName)}/red-team-report`;

  // Step 1: Get presigned upload URL
  const presignRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      result: opts.defenseScore,
      content_type: 'application/pdf',
    }),
  });

  if (!presignRes.ok) {
    const body = await presignRes.text();
    throw new Error(`Failed to get upload URL (${presignRes.status}): ${body}`);
  }

  const { upload_url, key } = (await presignRes.json()) as PresignedResponse;

  // Step 2: Upload PDF to presigned URL
  const pdfBuffer = fs.readFileSync(opts.pdfPath);

  const uploadRes = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/pdf',
    },
    body: pdfBuffer,
  });

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`Failed to upload PDF (${uploadRes.status}): ${body}`);
  }

  return key;
}
