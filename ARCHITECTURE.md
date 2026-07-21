# Arquitectura del Servidor Multiplayer (WebSocket)

Este documento describe la arquitectura del backend diseñado para soportar múltiples jugadores conectados a través de salas, utilizando servicios Serverless de AWS.

## 1. Descripción General de la Arquitectura

La solución se compone de tres servicios principales de AWS:

1. **Amazon API Gateway (WebSockets)**: Actúa como el punto de entrada para todas las conexiones de los clientes (jugadores). Mantiene las conexiones persistentes y rutea los mensajes entrantes hacia la función Lambda. API Gateway asigna internamente un `connectionId` muy largo a cada cliente.
2. **AWS Lambda**: Contiene la lógica de negocio. Se encarga de procesar los eventos de conexión (`$connect`, `$disconnect`), la asignación de IDs (`get_id`) y el ruteo de mensajes entre los distintos clientes (`route`).
3. **Amazon DynamoDB**: Base de datos NoSQL ultrarrápida que utilizamos para crear **Alias Cortos**. Como los `connectionId` de API Gateway son muy largos y difíciles de compartir, la Lambda genera un alias de 6 caracteres (ej. `A4F9K2`) y lo guarda en DynamoDB vinculado al `connectionId` real.

---

## 2. Preparación de DynamoDB (Con Auto-eliminación para evitar costos)

Para evitar que la base de datos crezca indefinidamente y genere costos innecesarios, utilizamos la característica de **TTL (Time to Live)** de DynamoDB. Esto permite que AWS elimine automáticamente los registros viejos sin costo adicional.

### Pasos para crear la tabla:
1. Ve a la consola de AWS y abre **DynamoDB**.
2. Haz clic en **Crear tabla**.
3. **Nombre de la tabla**: `RoomAliases` (puedes usar otro nombre, pero recuerda configurarlo en la Lambda).
4. **Clave de partición**: Escribe `alias` y selecciona el tipo **Cadena (String)**.
5. Deja los demás ajustes por defecto y haz clic en **Crear tabla**.

### Pasos para habilitar la auto-eliminación (TTL):
1. Una vez creada la tabla, entra a los detalles de la misma.
2. Ve a la pestaña **Configuración adicional** (o "Additional settings").
3. Busca la sección **Tiempo de vida (TTL)** y haz clic en **Habilitar** (o "Activar").
4. En el campo **Nombre del atributo TTL**, escribe exactamente `expiration`.
5. Guarda los cambios. (El proceso de activación puede tardar unos minutos en reflejarse).

> **Nota**: Con esto, la Lambda insertará un timestamp calculando 60 minutos hacia el futuro. Una vez que ese tiempo se cumpla, DynamoDB eliminará el registro en segundo plano sin que pagues por operaciones de borrado.

---

## 3. Preparación de la Función Lambda

La Lambda necesita permisos para hablar con DynamoDB y requiere saber el nombre de la tabla que acabas de crear.

### A. Configurar Variables de Entorno
1. En la consola de tu función Lambda, ve a la pestaña **Configuración** > **Variables de entorno**.
2. Añade una nueva variable:
   - **Clave**: `TABLE_NAME`
   - **Valor**: `RoomAliases` (o el nombre que le hayas dado a tu tabla).

### B. Otorgar Permisos de IAM
Tu Lambda necesita permisos para leer y escribir en DynamoDB. 
1. En la pestaña **Configuración** de tu Lambda, ve a **Permisos**.
2. Haz clic en el nombre del **Rol de ejecución** (esto abrirá la consola de IAM).
3. En la consola de IAM, haz clic en **Agregar permisos** > **Crear política en línea** (Inline policy).
4. Selecciona la pestaña **JSON** y pega el siguiente código:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "dynamodb:PutItem",
                "dynamodb:GetItem"
            ],
            "Resource": "arn:aws:dynamodb:TU_REGION:TU_ACCOUNT_ID:table/TU_NOMBRE_DE_TABLA"
        }
    ]
}
```
*(No olvides reemplazar `TU_REGION`, `TU_ACCOUNT_ID` y `TU_NOMBRE_DE_TABLA` con tus datos. Por ejemplo: `arn:aws:dynamodb:us-east-1:123456789012:table/RoomAliases`)*

5. Ponle un nombre a la política (ej. `DynamoDBAliasAccess`) y guárdala.

---

## 4. Flujo de Trabajo (Cómo funciona)

1. **El host se conecta**: API Gateway le asigna un ID largo. El host envía la acción `get_id` a la Lambda.
2. **Generación del Alias**: La Lambda genera un código de 6 letras/números, lo guarda en DynamoDB (con expiración en 1 hora) y se lo devuelve al host.
3. **Compartir el Alias**: El host comparte el código corto con sus amigos (guests).
4. **Envío de mensajes**: Cuando el host o un guest quiere enviar un mensaje, usan el alias corto como `target`. La Lambda busca ese alias en DynamoDB, encuentra el ID largo original, y rutea el mensaje a través de API Gateway de manera transparente.
