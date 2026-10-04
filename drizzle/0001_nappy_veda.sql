CREATE UNIQUE INDEX `idx_operations_active_resource` ON `operations` (`operation_type`,`resource_key`) WHERE "operations"."status" in ('starting','queued','running');
