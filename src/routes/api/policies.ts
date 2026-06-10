import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { getEffectivePolicies, setPolicy } from '../../services/policies';

const router = Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  const tenantId = req.query.tenantId as string | undefined;
  if (!tenantId) {
    res.status(400).json({ error: 'tenantId is required' });
    return;
  }
  const policies = await getEffectivePolicies(tenantId);
  res.json(policies);
});

const patchSchema = z.object({
  tenantId: z.string().min(1),
  permission: z.enum(['approval', 'auto', 'disabled']).optional(),
  requireVerification: z.boolean().optional(),
});

router.patch('/:actionType', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  const { tenantId, permission, requireVerification } = parsed.data;

  const updated = await setPolicy(tenantId, req.params.actionType, { permission, requireVerification });
  if (!updated) {
    res.status(404).json({ error: `Unknown action type: ${req.params.actionType}` });
    return;
  }
  res.json(updated);
});

export default router;
