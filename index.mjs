import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

// El nombre de la tabla se tomará de la variable de entorno, por defecto será RoomAliases
const TABLE_NAME = process.env.TABLE_NAME || "RoomAliases";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const generateAlias = () => {
  let alias = "";
  for (let i = 0; i < 6; i++) {
    alias += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
  }
  return alias;
};

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const routeKey = event.requestContext.routeKey;
  const domainName = event.requestContext.domainName;
  const stage = event.requestContext.stage;

  // Configure API Gateway Management API Client
  const apigwManagementApi = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });

  try {
    switch (routeKey) {
      case "$connect":
        // Connection handled successfully
        break;

      case "$disconnect":
        // Disconnection handled successfully
        // Nota: DynamoDB limpiará el alias automáticamente gracias al TTL.
        break;

      case "get_id": {
        // Generar el alias de 6 caracteres
        let alias = generateAlias();
        
        // TTL de 60 minutos como se solicitó
        const expiration = Math.floor(Date.now() / 1000) + (60 * 60);

        try {
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
              alias: alias,
              connectionId: connectionId,
              expiration: expiration
            },
            // Evitar sobreescribir si por extrema casualidad se repite
            ConditionExpression: "attribute_not_exists(alias)"
          }));

          // Enviar el alias de vuelta al cliente
          await apigwManagementApi.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: new TextEncoder().encode(JSON.stringify({
              type: "your_id",
              id: alias
            }))
          }));
        } catch (e) {
          console.error("Error storing alias:", e);
          // Si el alias ya existe, podríamos reintentar, pero para simplificar devolvemos error
          if (e.name === "ConditionalCheckFailedException") {
             console.error("Alias collision detected.");
          }
          return { statusCode: 500, body: 'Failed to generate alias' };
        }
        break;
      }

      case "route": {
        // Client wants to route a message to other connection(s) using aliases
        const body = JSON.parse(event.body);
        const { targets, payload } = body;
        
        if (!targets || !payload) {
          return { statusCode: 400, body: 'Missing targets or payload' };
        }

        const targetArray = Array.isArray(targets) ? targets : [targets];
        const resolvedConnectionIds = [];
        
        // Buscar los connectionIds reales en DynamoDB para cada alias
        const resolvePromises = targetArray.map(async (alias) => {
          try {
            const response = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { alias }
            }));
            
            if (response.Item && response.Item.connectionId) {
              resolvedConnectionIds.push(response.Item.connectionId);
            } else {
              console.warn(`Alias ${alias} no encontrado o ha expirado.`);
            }
          } catch (e) {
            console.error(`Error resolving alias ${alias}:`, e);
          }
        });

        await Promise.all(resolvePromises);
        
        // Send the payload to all resolved connection IDs
        const postPromises = resolvedConnectionIds.map(async (targetId) => {
          try {
            await apigwManagementApi.send(new PostToConnectionCommand({
              ConnectionId: targetId,
              Data: new TextEncoder().encode(JSON.stringify(payload))
            }));
          } catch (e) {
            if (e.name === 'GoneException') {
              console.log(`Connection ${targetId} is gone.`);
            } else {
              console.error(`Error sending to ${targetId}:`, e);
            }
          }
        });

        await Promise.all(postPromises);
        break;
      }

      default:
        console.warn(`Unsupported route: "${routeKey}"`);
        return { statusCode: 400, body: `Unsupported route: "${routeKey}"` };
    }
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Failed to process request: ' + err.message };
  }

  return { statusCode: 200, body: 'OK' };
};
