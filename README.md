# Guía paso a paso para ejecución
## Requisitos previos

1) Asegurarse de tener descargado en la computadora Nodejs y Git.

2) Descargar dependencias Lambda

   Dependencias del lambda_backend
   
        
   EN (**cd TripMate-infra/app_code/lambdas/lambda_backend**)
   
        npm ci --only=production


   Dependencias del lambda_dbinit
   
        
  EN (**cd TripMate-infra/app_code/lambdas/lambda_dbinit**)
   
        npm ci --only=production

4) Configurar AWS CLI

En la dirección main del proyecto (**cd TripMate-infra**)
    aws configure


        Credenciales
        Región: us-east-1
        Default output format: json

4) Ejecutar Terraform

   En la dirección main del proyecto (**cd TripMate-infra**)
       
        terraform init
        terraform apply -var-file="env/dev.tfvars"

5) Acceso a la aplicación

Una vez levantado, Entrar al link de s3_website que aparece en terminal.
Te va a dirigir a una página de bienvenida donde habrá un botón para iniciar sesión con cognito.
Te lleva al login de cognito y una vez iniciada sesión entra a la app.
Una vez dentro de la app el usuario puede crear viajes (poner nombre del viaje → guardar → esperar unos segundos → apretar listar viajes).
También existe la funcionalidad dentro de cada viaje crear actividades y votar.

Sobre la funcionalidad de UNIRSE:
Al iniciar sesión con otra cuenta en cognito y pegando el código del viaje creado por la otra persona ahora más de un usuario puede estar en un mismo viaje.

(Si un usuario agrega una actividad el otro usuario debe refrescar la página y volver a presionar el botón listar → abrir el viaje para que le aparezca la nueva actividad. Al igual que los nuevos votos).
Cada vez que el usuario entra a la app tiene que presionar LISTAR VIAJES para verlos.
Eliminar viaje → Solo el usuario CREADOR del viaje lo puede eliminar.


## Descripción de módulos

### COGNITO_AUTH

Este módulo se encarga de crear todo lo necesario para manejar usuarios con Amazon Cognito.
Básicamente, genera un User Pool donde los usuarios se registran e inician sesión usando su email como nombre de usuario.
También activa la verificación automática por correo y permite recuperar la cuenta si el usuario la pierde.
La política de contraseñas es bastante simple, y además genera un dominio único para el login, así no se choca con otros entornos.
Como salida, muestra datos importantes como el ID del User Pool y la URL del dominio para el login.

### RDS_MYSQL

Este módulo crea una base de datos MySQL en Amazon RDS, que se usa para guardar la información de la aplicación.
Primero define un subnet group dentro de la VPC para que la base quede bien ubicada en la red privada.
Después levanta una instancia de MySQL con un tamaño chico y 20GB de almacenamiento.
La base no es pública y se puede activar o no la opción Multi-AZ por si se necesita más disponibilidad.
La autenticación se hace con usuario y contraseña que vienen por variables, y el nombre de la base se genera automáticamente.
Al final, el módulo devuelve el endpoint de la base de datos, que es la dirección para conectarse desde las Lambdas.

### S3_WEBSITE

Este módulo sirve para publicar la parte web del proyecto (el frontend) usando Amazon S3.
Lo que hace es crear un bucket único con nombre dinámico, para evitar que se repita con otros proyectos.
Dentro del bucket se activa el hosting estático, configurando el archivo login.html como página principal.
Además, sube directamente los archivos HTML y JavaScript del proyecto (login y app) con el código JS inyectado por Terraform.
Finalmente, muestra como salida la URL del sitio web, para poder acceder directamente al frontend.

### SNS_TOPIC

Este módulo crea un tópico SNS para mandar notificaciones o alertas del sistema.
Se genera un nombre único con un sufijo aleatorio para evitar conflictos entre equipos o ambientes.
También permite agregar una suscripción por email, pero solo si se pasa una dirección de correo en las variables.
Si no se pone nada, no se crea y no tira error (gracias al COUNT condicional).
El módulo devuelve el ARN del topic, que se puede usar para conectarlo con las Lambdas o con otros servicios que necesiten enviar notificaciones.

### VPC_EXT

Este módulo arma toda la infraestructura de red (VPC) del proyecto.
Usa el módulo oficial de AWS para crear las subredes públicas, privadas y de base de datos, además de configurar un NAT Gateway para que las Lambdas puedan salir a Internet sin ser accesibles desde afuera.
También crea dos grupos de seguridad (SGs):

Uno para las Lambdas, que solo permite tráfico de salida.

Otro para la base de datos, que deja entrar solo conexiones en el puerto 3306 desde las Lambdas.

Como outputs, devuelve los IDs de las subnets, los SGs y el ID de la VPC.

### LAMBDAS_API

Se encarga de todo el backend del sistema, usando AWS Lambda (para ejecutar funciones sin servidor) y API Gateway (para exponer endpoints REST).
Tiene 4 funciones Lambda:

backend: maneja las operaciones principales como guardar, listar, unirse a viajes, votar, etc.

callback: se usa cuando el usuario vuelve del login de Cognito.

signout: cierra la sesión y redirige al login.

dbinit: inicializa la base de datos.

Cada Lambda se empaqueta automáticamente en ZIP y se conecta a la VPC para poder hablar con RDS.
La API Gateway expone rutas como /guardar, /listar, /unirse, /callback, /signout y /viajes/{id}/actividades, todas conectadas con las Lambdas mediante integraciones tipo proxy.
Tiene configurado CORS para que el frontend pueda hacer llamadas sin bloqueos.
Por último, también crea un User Pool Client de Cognito con OAuth 2.0, que se usa para manejar el login y logout desde el frontend.

## Explicación de funciones y meta-argumentos


### Funciones usadas

#### file()
Por ejemplo en: main.tf del módulo s3_website
Sirve para leer archivos HTML desde el disco (como el login.html) y meterlos en el bucket de S3.

content = join("", [file(var.login_file_path), "\n<script>\n", var.login_inline_js, "\n</script>\n"])


#### join()
Por ejemplo en: main.tf en s3_website
Sirve para unir contenido HTML y JavaScript en un solo string. Muy útil para inyectar el JS al final del archivo HTML.

#### coalesce()
Por ejemplo en: main.tf en lambdas_api
Sirve para usar un valor por defecto si no se pasó uno. En este caso, para el origen de CORS.

allow_origin = coalesce(var.cors_origin, "http://${local.frontend_host}")


#### replace()
Por ejemplo en: main.tf en s3_website
Se usa para reemplazar caracteres no válidos (como guiones bajos) en nombres de buckets.

#### lower()
Por ejemplo en: main.tf en cognito_auth y s3_website
Sirve para pasar strings a minúsculas, ya que algunos nombres en AWS lo exigen.

#### trimspace()
Por ejemplo en: main.tf en sns_topic
Sirve para eliminar espacios vacíos de un string antes de chequear si está vacío o no.

#### element() y compact()
Por ejemplo en: main.tf en s3_website
Sirve para elegir un nombre válido de bucket, tomando el que se pasó o el que se generó dinámicamente.

#### merge()
Por ejemplo en: main.tf de s3_website
Se usa para unir dos grupos de etiquetas en uno solo. Combina las etiquetas generales del proyecto (var.tags) con una etiqueta adicional llamada Name.

### Meta-argumentos usados

#### count
Por ejemplo en: main.tf en sns_topic, y también en creación de roles en lambdas_api.
Se usó para crear recursos solo si se cumple una condición (por ejemplo, la suscripción por email solo se crea si se pasó un correo).

#### depends_on
Por ejemplo en: main.tf en s3_website y main.tf en lambdas_api.
Se usó para decirle a Terraform que espere a que un recurso se cree antes de avanzar (por ejemplo, esperar que se configuren los permisos públicos del bucket antes de aplicar la política).

#### lifecycle
Por ejemplo en: main.tf en lambdas_api.
Se usó para evitar que Terraform destruya un recurso antes de crear el nuevo.

lifecycle { 
  create_before_destroy = true 
}


<img width="1372" height="1332" alt="DIAGRAMA TRIPMATE drawio" src="https://github.com/user-attachments/assets/4fd8b70d-c8d1-4f75-9c4b-dcbf32e7b4c5" />



IMAGEN 
