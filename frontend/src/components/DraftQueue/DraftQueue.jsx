import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { useDraft } from '../../context/DraftContext';

/**
 * Drag-and-drop queue of target players for the live draft.
 */
export default function DraftQueue({ availablePlayers }) {
  const { queue, reorderQueue, removeFromQueue } = useDraft();

  const queuePlayers = queue
    .map(id => availablePlayers.find(p => (p.sleeperId || p._id?.toString()) === id))
    .filter(Boolean);

  const onDragEnd = (result) => {
    if (!result.destination) return;
    const reordered = Array.from(queue);
    const [moved] = reordered.splice(result.source.index, 1);
    reordered.splice(result.destination.index, 0, moved);
    reorderQueue(reordered);
  };

  if (queuePlayers.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>+</div>
        <div className="text-sm">Add players to your queue from the board below</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: '0.75rem' }}>
      <div className="flex justify-between items-center" style={{ marginBottom: '0.5rem' }}>
        <span className="font-semibold text-sm">My Queue ({queuePlayers.length})</span>
        <span className="text-xs text-muted">Drag to reorder</span>
      </div>

      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="queue">
          {(provided) => (
            <div ref={provided.innerRef} {...provided.droppableProps} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {queuePlayers.map((player, index) => {
                const id = player.sleeperId || player._id?.toString();
                return (
                  <Draggable key={id} draggableId={id} index={index}>
                    {(prov, snap) => (
                      <div
                        ref={prov.innerRef}
                        {...prov.draggableProps}
                        {...prov.dragHandleProps}
                        style={{
                          ...prov.draggableProps.style,
                          background: snap.isDragging ? 'var(--bg-card-hover)' : 'var(--bg-primary)',
                          borderRadius: 6,
                          padding: '0.5rem 0.75rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <span className="text-muted text-xs" style={{ width: '1.2rem', textAlign: 'center' }}>{index + 1}</span>
                        <span className={`badge badge-${player.position}`}>{player.position}</span>
                        <span style={{ flex: 1, fontSize: '0.9rem', fontWeight: 600 }}>{player.name}</span>
                        {player.availabilityProb != null && (
                          <span className={`text-xs ${player.availabilityProb < 0.3 ? 'text-red' : player.availabilityProb < 0.6 ? 'text-yellow' : 'text-green'}`}>
                            {Math.round(player.availabilityProb * 100)}%
                          </span>
                        )}
                        <button
                          className="btn btn-ghost text-xs"
                          style={{ padding: '0', color: 'var(--text-muted)', fontSize: '1rem' }}
                          onClick={() => removeFromQueue(id)}
                          aria-label="Remove"
                        >
                          x
                        </button>
                      </div>
                    )}
                  </Draggable>
                );
              })}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>
    </div>
  );
}
