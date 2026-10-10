import { CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";

const endpoint = process.env.AWS_ENDPOINT_URL;
export const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? "eu-west-3",
  ...(endpoint ? { endpoint, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test" } } : {})
});

let cachedQueueUrl: string | undefined;
export async function resolveQueueUrl(): Promise<string> {
  if (cachedQueueUrl) return cachedQueueUrl;
  const name = process.env.SQS_QUEUE_NAME ?? "partner-exports";
  if (endpoint) {
    const deadLetterName = process.env.SQS_DLQ_QUEUE_NAME ?? `${name}-dlq`;
    const deadLetter = await sqs.send(new CreateQueueCommand({ QueueName: deadLetterName }));
    if (!deadLetter.QueueUrl) throw new Error("Unable to create the local dead-letter queue");
    const deadLetterAttributes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: deadLetter.QueueUrl,
      AttributeNames: ["QueueArn"]
    }));
    const deadLetterArn = deadLetterAttributes.Attributes?.QueueArn;
    if (!deadLetterArn) throw new Error("Local dead-letter queue has no ARN");
    const created = await sqs.send(new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        VisibilityTimeout: "30",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: deadLetterArn, maxReceiveCount: "5" })
      }
    }));
    if (!created.QueueUrl) throw new Error("Unable to create the local export queue");
    cachedQueueUrl = created.QueueUrl;
    return cachedQueueUrl;
  }
  try {
    const result = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) throw new Error("SQS returned no queue URL");
    cachedQueueUrl = result.QueueUrl;
    return cachedQueueUrl;
  } catch {
    throw new Error(`SQS queue '${name}' is not available; provision it before starting Streamline.`);
  }
}
