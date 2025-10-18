# Wrapper del módulo externo oficial de VPC
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.project}-vpc"
  cidr = "10.0.0.0/16"

  azs              = ["us-east-1a", "us-east-1b"]
  public_subnets   = ["10.0.1.0/24", "10.0.2.0/24"]
  private_subnets  = ["10.0.11.0/24", "10.0.12.0/24"] # para Lambdas
  database_subnets = ["10.0.21.0/24", "10.0.22.0/24"] # para RDS

  enable_nat_gateway = true
  single_nat_gateway = true

  tags = var.tags
}

# SG para Lambdas (egress-only)
resource "aws_security_group" "lambda" {
  name        = "${var.project}-sg-lambda"
  description = "Lambda outbound only"
  vpc_id      = module.vpc.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}

# SG para RDS: permite 3306 desde SG de Lambda
resource "aws_security_group" "rds" {
  name        = "${var.project}-sg-rds"
  description = "RDS MySQL 3306 from Lambda SG"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}
