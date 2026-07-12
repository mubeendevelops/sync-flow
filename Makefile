.PHONY: up down logs psql redis-cli reset

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

psql:
	docker compose exec postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

redis-cli:
	docker compose exec redis redis-cli

reset:
	docker compose down -v
	docker compose up -d
