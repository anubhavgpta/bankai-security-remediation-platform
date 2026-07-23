-- A remediation branch is the first concrete remediation artifact. Tickets
-- that have a branch but no pull request should live in "In Progress" so the
-- UI can offer a fix-generation retry instead of leaving them in "To Do".
update public.tickets
set status = 'In Progress'
where status = 'To Do'
  and github_branch_name is not null
  and github_pr_number is null;
