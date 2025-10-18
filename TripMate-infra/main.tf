
resource "random_id" "unique" {
  byte_length = 3   # genera 6 caracteres hex
}

locals {
  project_unique = "${var.project_name}-${random_id.unique.hex}"
  cognito_domain_prefx = "tripmate-${random_id.unique.hex}"
}


provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile == "" ? null : var.aws_profile
}


# Detecta automáticamente el ID de cuenta (sirve para todos los labs)
data "aws_caller_identity" "current" {}


data "aws_iam_role" "labrole" {
  name = "LabRole"
  # Si no existe, Terraform ignora el error (gracias a try())
  count = 1
}

###################################
# FRONTEND RENDER AUTOMÁTICO
###################################
locals {
  api_invoke_url   = module.lambdas_api.api_invoke_url
  frontend_origin  = "http://${module.s3_website.website_hostname}"
  frontend_hostname = module.s3_website.website_hostname


#----------------------------------------------------------------------------------------------------------------------------------------
#SI NO FUNCIONA EN OTRA PC BORRAR ESTA LINEA

  lambda_role_final = try("arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/LabRole", null)
#-----------------------------------------------------------------------------------------------------------------------------------------------------------


  # ==== JS que se inyecta dinámicamente ====
  rendered_login_js = <<EOT
  (function(){
    var CD  = "${module.cognito_auth.domain_url}";
    var CID = "${module.lambdas_api.cognito_client_id}";
    var RU  = "${module.lambdas_api.api_invoke_url}/callback";
    var SC  = encodeURIComponent('openid email profile');
    var btn = document.getElementById('login');
    if(btn){
      btn.onclick = function(){
        var url = CD + "/oauth2/authorize?client_id=" + encodeURIComponent(CID) +
                  "&response_type=code&scope=" + SC +
                  "&redirect_uri=" + encodeURIComponent(RU);
        window.location = url;
      };
    }
  })();
  EOT

  rendered_app_js = <<EOT
  (function(){
    window.API_BASE          = "${module.lambdas_api.api_invoke_url}";
    window.COGNITO_DOMAIN    = "${module.cognito_auth.domain_url}";
    window.COGNITO_CLIENT_ID = "${module.lambdas_api.cognito_client_id}";
    window.SIGNOUT_REDIRECT  = "${module.lambdas_api.api_invoke_url}/signout";
  })();
  EOT
}


################
#   VPC + SG   #
################
module "vpc_ext" {
  source  = "./modules/vpc_ext"
  project = local.project_unique
  tags    = var.tags
}

################
#     RDS      #
################
module "rds_mysql" {
  source              = "./modules/rds_mysql"
  project             = local.project_unique
  tags                = var.tags
  subnet_ids          = module.vpc_ext.db_subnet_ids
  vpc_security_groups = [module.vpc_ext.sg_rds_id]

  db_username = var.db_username
  db_password = var.db_password
  db_name     = var.db_name

  multi_az = true
}

################
#     SNS      #
################
module "sns" {
  source  = "./modules/sns_topic"
  project = local.project_unique
  tags    = var.tags
  email   = var.sns_email_subscription
}

################
#   COGNITO    #
################
module "cognito_auth" {
  source  = "./modules/cognito_auth"
  project = local.project_unique
  tags    = var.tags
  region  = var.aws_region

  
  domain_prefix = local.cognito_domain_prefx
}


#############################
#  LAMBDAS + API GATEWAY    #
#############################
module "lambdas_api" {


#si no funciona en otra pc CAMBIAR ETSA LINEA POR LA ANTERIOR--------------------------------------------------------------------------------------------
  lambda_role_arn = local.lambda_role_final
#-----------------------------------------------------------------------------------------------------------------------------------------------------------------

  source          = "./modules/lambdas_api"
  project         = local.project_unique
  tags            = var.tags
  region          = var.aws_region

  stage_name = "prod"

  lambda_subnet_ids = module.vpc_ext.app_subnet_ids
  lambda_sg_id      = module.vpc_ext.sg_lambda_id

  db_host     = module.rds_mysql.endpoint
  db_user     = var.db_username
  db_password = var.db_password
  db_name     = var.db_name

  sns_topic_arn = module.sns.topic_arn
  user_pool_id  = module.cognito_auth.user_pool_id
  domain_url    = module.cognito_auth.domain_url

  lambda_backend_dir  = "${path.root}/app_code/lambdas/lambda_backend"
  lambda_callback_dir = "${path.root}/app_code/lambdas/lambda_callback"
  lambda_dbinit_dir   = "${path.root}/app_code/lambdas/lambda_dbinit"
  lambda_signout_dir  = "${path.root}/app_code/lambdas/lambda_signout"

  frontend_hostname = module.s3_website.website_hostname
  cors_origin       = "http://${module.s3_website.website_hostname}"
}

################
#     S3       #
################
module "s3_website" {
  source  = "./modules/s3_website"
  project = local.project_unique
  tags    = var.tags
  region  = var.aws_region

  website_bucket_name = var.website_bucket_name

  login_file_path = "${path.root}/app_code/web/login.html"
  app_file_path   = "${path.root}/app_code/web/app.html"

  login_inline_js = local.rendered_login_js
  app_inline_js   = local.rendered_app_js
}