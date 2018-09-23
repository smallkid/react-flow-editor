import * as React from 'react';
import * as _ from 'lodash';

import { ChangeAction } from './change-api';
import { Vector2d, Rect } from './geometry';
import { BUTTON_LEFT, KEY_CODE_DELETE, BUTTON_MIDDLE } from './constants';
import { Connection, BaseInput, BaseOutput, Size, BaseConnection, Node } from './types';

//#region "Type definitions"

const compareConnections = (a: Connection) => (b: Connection) => a.port === b.port && a.nodeId === b.nodeId;

export interface Config {
    resolver: (payload: any) => JSX.Element;
    connectionValidator?: (output: { nodeId: string, connectionId: number }, input: { nodeId: string, connectionId: number }) => boolean;
    onChanged?: (node: ChangeAction) => void;
    connectionType?: 'bezier' | 'linear';
    showGrid?: boolean;
}

export namespace Editor {
    export interface Props {
        config: Config;
        nodes: Node[];
    }
}

interface NodeState {
    pos: Vector2d;
    size: Vector2d;
    offset?: Vector2d;
    isCollapsed: boolean;
}

type ItemType = 'node' | 'connection';

interface WorkItemConnection {
    type: 'connection';
    input: Vector2d;
    output: Vector2d;
}
type WorkItem = WorkItemConnection;

type State = {
    nodesState: Map<string, NodeState>;
    connectionState: Map<string, Vector2d>;
    selection?: { type: ItemType, id: string };
    workingItem?: WorkItem;
    transformation: { dx: number, dy: number, zoom: number };
    componentSize: Size;
};

class Endpoint {
    nodeId: string;
    connectionId: number;
    kind: 'input' | 'output';

    static computeId(nodeId: Endpoint['nodeId'], connectionId: Endpoint['connectionId'], kind: Endpoint['kind']) {
        return `${nodeId}_${connectionId}_${kind}`;
    }

    static computeIdIn(conn: Endpoint) {
        return `${conn.nodeId}_${conn.connectionId}_${conn.kind}`;
    }

    static extractEndpointInfo(id: string): Endpoint {
        const regex = /(.+)_(\d+)_(input|output)/g;
        const match = regex.exec(id);
        if (match === null) throw Error(`Illegal id string ${id}`);
        return { nodeId: match[1], connectionId: parseInt(match[2]), kind: match[3] as any };
    }
}

//#endregion "Type definitions"
//#region "Helper function"

function computeConnectionId(input: Endpoint, output: Endpoint) {
    return `${Endpoint.computeIdIn(input)}__${Endpoint.computeIdIn(output)}`;
}

/**
 * The reverse of computeConnectionId
 */
function extractConnectionFromId(id: string) {
    const sepIndex = id.indexOf('__');
    const inputId = id.substr(0, sepIndex);
    const outputId = id.substr(sepIndex + 2);
    return { input: Endpoint.extractEndpointInfo(inputId), output: Endpoint.extractEndpointInfo(outputId) };
}

function isEmptyArrayOrUndefined(obj) {
    return obj === undefined || (Array.isArray(obj) && obj.length === 0);
}

const nodeIdPredicate = (connection: Connection | Connection[]) => (node: Node) => Array.isArray(connection) ? connection.findIndex(conn => conn.nodeId === node.id) >= 0 : node.id === connection.nodeId;

const epPredicate = (nodeId: string, port?: number) => (ep: BaseConnection) => {
    const comp = (testee: Connection) => (port === undefined || testee.port === port) && testee.nodeId === nodeId;
    return Array.isArray(ep.connection) ? ep.connection.findIndex(comp) >= 0 : comp(ep.connection);
};

//#endregion "Helper function"

export class Editor extends React.Component<Editor.Props, State> {

    private currentAction?: {
        lastPos: Vector2d, id: string, type: 'node'
    } | { lastPos: Vector2d, endpoint: Endpoint, type: 'connection' } | { lastPos: Vector2d, type: 'translate' };
    private endpointCache: Map<string, Vector2d>;
    private gridSize?: Size;
    private editorBoundingRect?: DOMRect;

    constructor(props: Editor.Props) {
        super(props);
        this.endpointCache = new Map<string, Vector2d>();
        this.state = this.initialState();
        (window as any).onCreateNode = this.createNewNode.bind(this);
        (window as any).onStartCreatingNewNode = this.onStartCreatingNewNode.bind(this);
        // this.editorBoundingRect = { x: 0, y: 0, height: 0, width: 0, bottom: 0, left: 0, top: 0, right: 0 };
    }

    private initialState() {
        const { props } = this;
        const nodesState = new Map<string, NodeState>();
        const connectionState = new Map<string, Vector2d>();
        const margin = { x: 100, y: 100 };
        const usedPlace: Rect[] = [];
        for (let node of props.nodes) {
            // Find suitable place
            const pos = node.position || { x: 10 + margin.x, y: 10 + margin.y };
            for (let place of usedPlace) {
                if (place.hit(pos))
                    pos.x = place.right + margin.x;
                pos.y = place.top;
            }
            const size = { x: 100, y: 100 };    // TODO: get size out of ref
            nodesState.set(node.id, { pos, size, isCollapsed: false });
            usedPlace.push(new Rect(pos, size));

            for (let k in node.inputs) {
                const i = parseInt(k);
                const inputPos = { x: pos.x, y: pos.y + 100 + i * 100 };
                const key = Endpoint.computeId(node.id, i, 'input');
                connectionState.set(key, inputPos);
            }
            for (let k in node.outputs) {
                const i = parseInt(k);
                const outputPos = { x: pos.x + size.x, y: pos.y + 100 + i * 100 };
                const key = Endpoint.computeId(node.id, i, 'output');
                connectionState.set(key, outputPos);
            }
        }
        const transformation = { dx: 0, dy: 0, zoom: 1 };
        const componentSize: Size = { width: 800, height: 600 };
        return { nodesState, connectionState, transformation, componentSize };
    }

    //#region "User interaction"

    private select(type: ItemType, id: string) {
        if (!this.state.selection || this.state.selection.id !== id) {
            this.setState(state => {
                return { ...state, selection: { id, type } };
            });
        }
    }

    private toggleExpandNode(id: string) {
        this.setState(state => {
            state.nodesState.get(id).isCollapsed = !state.nodesState.get(id).isCollapsed;
            return { ...state };
        });
    }

    private onDragStarted(id: string, e: React.MouseEvent) {
        if (e.button === BUTTON_LEFT)
            this.currentAction = { lastPos: { x: e.clientX, y: e.clientY }, id: id, type: 'node' };
    }

    private onDragEnded(e: React.MouseEvent) {
        this.currentAction = undefined;
        this.setState(state => ({ ...state, workingItem: undefined }));
    }

    private onDrag(e: React.MouseEvent) {
        if (this.currentAction === undefined) return;
        const newPos = { x: e.clientX, y: e.clientY };
        const { x: dx, y: dy } = Vector2d.subtract(newPos, this.currentAction.lastPos);
        this.setState(state => {
            if (this.currentAction.type === 'node') {
                state.nodesState.get(this.currentAction.id).pos.x += dx;
                state.nodesState.get(this.currentAction.id).pos.y += dy;
                return { ...state };
            }
            else if (this.currentAction.type === 'connection') {
                const { endpoint } = this.currentAction;
                const free = Vector2d.subtract(newPos, this.editorBoundingRect);

                const key = Endpoint.computeId(endpoint.nodeId, endpoint.connectionId, endpoint.kind);

                const offset = this.state.connectionState.get(key);
                const node = this.state.nodesState.get(endpoint.nodeId);

                const fixed = Vector2d.add(offset, node.pos);

                if (endpoint.kind === 'input') {
                    const workingItem: WorkItem = { type: 'connection', input: fixed, output: free };
                    return { ...state, workingItem };
                } else if (endpoint.kind === 'output') {
                    const workingItem: WorkItem = { type: 'connection', input: free, output: fixed };
                    return { ...state, workingItem };
                }
            }
            else if (this.currentAction.type === 'translate') {
                const pt = this.state.transformation;
                const transformation = { dx: pt.dx + dx, dy: pt.dy + dy, zoom: pt.zoom };
                this.setState(state => ({ ...state, transformation }));
            }
        });
        this.currentAction.lastPos = newPos;
    }

    private onCreateConnectionStarted(endpoint: Endpoint, e: React.MouseEvent) {
        this.currentAction = { lastPos: { x: e.screenX, y: e.screenY }, endpoint, type: 'connection' };
    }

    private onCreateConnectionEnded(endpoint: Endpoint, e: React.MouseEvent) {
        if (this.currentAction && this.currentAction.type === 'connection') {
            // Create new connection
            if (this.currentAction.endpoint.kind === 'input') {
                this.createConnection(this.currentAction.endpoint, endpoint);
            }
            else if (this.currentAction.endpoint.kind === 'output') {
                this.createConnection(endpoint, this.currentAction.endpoint);
            }
        }
    }

    private removeFromArrayOrValue(value: Connection | Connection[], toRemove: Connection | Connection[]) {
        if (!Array.isArray(value))
            return undefined;
        if (Array.isArray(toRemove)) {
            for (let it of toRemove) {
                const index = value.findIndex(compareConnections(it));
                if (index < 0) return value;
                value.splice(index, 1);
                return value;
            }
        }
        else {
            const index = value.findIndex(compareConnections(toRemove));
            if (index < 0) return value;
            value.splice(index, 1);
            return value;
        }
    }
    private removeConnection(input: Endpoint, output: Endpoint) {

        const { nodes } = this.props;
        const inputNode = nodes.find(node => node.id === input.nodeId);
        const outputNode = nodes.find(node => node.id === output.nodeId);

        inputNode.inputs[input.connectionId].connection =
            this.removeFromArrayOrValue(inputNode.inputs[input.connectionId].connection, { nodeId: output.nodeId, port: output.connectionId });
        outputNode.outputs[output.connectionId].connection =
            this.removeFromArrayOrValue(outputNode.outputs[output.connectionId].connection, { nodeId: input.nodeId, port: input.connectionId });
    }

    private createConnection(input: Endpoint, output: Endpoint) {
        const { nodes, config } = this.props;
        const inputNode = nodes.find(node => node.id === input.nodeId);
        const outputNode = nodes.find(node => node.id === output.nodeId);

        const isArrayOrUndefined = variable => {
            return variable === undefined || Array.isArray(variable);
        };

        if (input.kind === output.kind) {
            // Can only create connection between input and output
            return;
        }

        if (!isArrayOrUndefined(inputNode.inputs[input.connectionId].connection) || !isArrayOrUndefined(outputNode.outputs[output.connectionId].connection)) {
            // Connections already exist
            return;
        }

        if (config.connectionValidator && !config.connectionValidator(output, input)) {
            // User validation not passed
            return;
        }
        const outputConnection = { nodeId: outputNode.id, port: output.connectionId };
        if (Array.isArray(inputNode.inputs[input.connectionId].connection))
            (inputNode.inputs[input.connectionId].connection as Connection[]).push(outputConnection);
        else
            inputNode.inputs[input.connectionId].connection = outputConnection;

        const inputConnection = { nodeId: inputNode.id, port: input.connectionId };
        if (Array.isArray(outputNode.outputs[output.connectionId].connection))
            (outputNode.outputs[output.connectionId].connection as Connection[]).push(inputConnection);
        else
            outputNode.outputs[output.connectionId].connection = inputConnection;

        config.onChanged({ type: 'ConnectionCreated', input, output });
        this.setState(state => state);
    }

    private onKeyDown(e: React.KeyboardEvent) {
        // console.log(`Key down: ${e.keyCode}`);

        const { selection } = this.state;
        if (e.keyCode === KEY_CODE_DELETE) {
            if (selection) {
                if (selection.type === 'connection') {
                    const { input, output } = extractConnectionFromId(selection.id);
                    this.removeConnection(input, output);
                    if (this.props.config.onChanged)
                        this.props.config.onChanged({ type: 'ConnectionRemoved', id: selection.id });
                }
                else if (selection.type === 'node') {
                    const index = this.props.nodes.findIndex(node => node.id === selection.id);
                    // Delete all corresponding connections
                    const nodeToDelete = this.props.nodes[index];
                    let inputIndex = -1;
                    for (let input of nodeToDelete.inputs) {
                        ++inputIndex;
                        if (isEmptyArrayOrUndefined(input.connection)) continue;
                        const peerNodes = this.props.nodes.filter(nodeIdPredicate(input.connection));//  find(nodePredicate(input.id));
                        for (let peerNode of peerNodes) {
                            const peerOutputs = peerNode.outputs.filter(epPredicate(nodeToDelete.id));
                            for (let peerOutput of peerOutputs)
                                peerOutput.connection = this.removeFromArrayOrValue(peerOutput.connection, { nodeId: nodeToDelete.id, port: inputIndex });
                        }
                    }

                    let outputIndex = -1;
                    for (let output of nodeToDelete.outputs) {
                        ++outputIndex;
                        if (isEmptyArrayOrUndefined(output.connection)) continue;
                        const peerNodes = this.props.nodes.filter(nodeIdPredicate(output.connection));
                        for (let peerNode of peerNodes) {
                            const peerInputs = peerNode.inputs.filter(epPredicate(nodeToDelete.id));
                            for (let peerInput of peerInputs)
                                peerInput.connection = this.removeFromArrayOrValue(peerInput.connection, { nodeId: nodeToDelete.id, port: outputIndex });
                        }
                    }

                    if (this.props.config.onChanged)
                        this.props.config.onChanged({ type: 'NodeRemoved', id: selection.id });
                    this.props.nodes.splice(index, 1);
                }

                this.setState((state) => {
                    return { ...state, selection: undefined };
                });
            }
        }
    }

    private onMouseGlobalDown(e: React.MouseEvent) {
        if (e.button === BUTTON_MIDDLE) {
            this.currentAction = { type: 'translate', lastPos: { x: e.clientX, y: e.clientY } };
        }
        else if (e.button === BUTTON_LEFT) {
            this.setState(state => {
                return { ...state, selection: undefined };
            });
        }
    }

    private onWheel(e: React.WheelEvent) {
        if (e.ctrlKey) return;
        const pt = this.state.transformation;
        const zoomFactor = Math.pow(1.25, Math.sign(e.deltaY));
        const zoom = pt.zoom * zoomFactor;

        const cx = e.clientX;
        const cy = e.clientY;
        // See https://github.com/lochbrunner/meliodraw/blob/master/Melio.Draw/SharpDX/OrthogonalCamera.cs#L116
        const dy = cy * (pt.zoom - zoom) + pt.dy;
        const dx = cx * (pt.zoom - zoom) + pt.dx;
        const transformation = { dx, dy, zoom };

        this.setState(state => ({ ...state, transformation }));
    }

    //#endregion "User interaction"

    private setConnectionEndpoint(conn: Endpoint, element: Element) {
        if (!element) return;
        // Only save relative position
        const parentPos = this.state.nodesState.get(conn.nodeId).pos;
        const key = Endpoint.computeId(conn.nodeId, conn.connectionId, conn.kind);
        const cached = this.endpointCache.get(key);
        const newDomRect: DOMRect = element.getBoundingClientRect() as DOMRect;
        const globalOffset: Vector2d = this.editorBoundingRect || { x: 0, y: 0 };
        const offset = {
            x: Math.floor(newDomRect.x + newDomRect.width / 2 - parentPos.x - globalOffset.x),
            y: Math.floor(newDomRect.y + newDomRect.height / 2 - parentPos.y - globalOffset.y)
        };
        if (cached === undefined || !Vector2d.compare(offset, cached)) {
            this.endpointCache.set(key, offset);
            setImmediate(() =>
                this.setState((state, props) => {
                    state.connectionState.set(key, offset);
                    return state;
                }));
        }

    }

    private updateEditorSize(element: Element) {
        if (element === null) return;
        const width = Math.floor((element as any).width.baseVal.value);
        const height = Math.floor((element as any).height.baseVal.value);

        if (width < 1 || height < 1) return;
        if (this.state.componentSize.width !== width || this.state.componentSize.height !== height)
            setImmediate(() => this.setState(state => ({ ...state, componentSize: { height, width } })));
    }

    private connection(outputConn: Endpoint, inputConn: Endpoint) {
        const { nodesState, connectionState } = this.state;
        const inputKey = Endpoint.computeId(inputConn.nodeId, inputConn.connectionId, inputConn.kind);
        const outputKey = Endpoint.computeId(outputConn.nodeId, outputConn.connectionId, outputConn.kind);
        const key = `${outputKey}_${inputKey}`;
        const connId = computeConnectionId(inputConn, outputConn);
        const isSelected = this.state.selection && this.state.selection.id === connId;

        const outputOffset = connectionState.get(outputKey);
        const inputOffset = connectionState.get(inputKey);
        const outputNode = nodesState.get(outputConn.nodeId);
        const inputNode = nodesState.get(inputConn.nodeId);

        const output = Vector2d.add(outputOffset, outputNode.pos);
        const input = Vector2d.add(inputOffset, inputNode.pos);

        return this.connectionPath(output, input, isSelected, key, this.select.bind(this, 'connection', connId));
    }

    private connectionPath(output: Vector2d, input: Vector2d, selected?: boolean, key?: string, onClick?: (e: React.MouseEvent) => void) {
        const a0 = output;
        const a3 = input;
        const dx = Math.max(Math.abs(a0.x - a3.x) / 1.5, 100);
        const a1 = { x: a0.x - dx, y: a0.y };
        const a2 = { x: a3.x + dx, y: a3.y };

        let cmd: string;

        if (this.props.config.connectionType === 'bezier')
            cmd = `M ${a0.x} ${a0.y} C ${a1.x} ${a1.y}, ${a2.x} ${a2.y}, ${a3.x} ${a3.y}`;
        else if (this.props.config.connectionType === 'linear')
            cmd = `M ${a0.x} ${a0.y} L ${a3.x} ${a3.y}`;

        const width = 3 * this.state.transformation.zoom;

        return <path className={selected ? 'connection selected' : 'connection'} onClick={onClick ? onClick : () => { }} key={key || 'wk'} strokeWidth={`${width}px`} d={cmd} />;
    }

    private onEditorUpdate(element: Element) {
        if (element === null) return;
        const rect = element.getBoundingClientRect() as DOMRect;

        if (this.editorBoundingRect === undefined ||
            this.editorBoundingRect.x !== rect.x ||
            this.editorBoundingRect.y !== rect.y) {
            this.editorBoundingRect = rect;
            this.setState(state => state);
        }
    }

    render() {

        const workingConnection = (info: WorkItemConnection) => {
            return this.connectionPath(info.output, info.input);
        };

        const { props, state } = this;

        const nodeStyle = (pos: Vector2d) => ({
            top: `${pos.y}px`,
            left: `${pos.x}px`,
        });

        const properties = (node: Node) => {
            const dot = (conn: Endpoint) => {
                return <div
                    onMouseDown={this.onCreateConnectionStarted.bind(this, conn)}
                    onMouseUp={this.onCreateConnectionEnded.bind(this, conn)}
                    ref={this.setConnectionEndpoint.bind(this, conn)}
                    className={`dot ${conn.kind}`} />;
            };
            const mapProp = (kind: Endpoint['kind']) => (prop: BaseConnection, i: number) => {
                const key = Endpoint.computeId(node.id, i, kind);
                return (
                    <div key={key}>
                        {prop.renderer ? prop.renderer(prop) : prop.name}
                        {dot({ nodeId: node.id, connectionId: i, kind: kind })}
                    </div>
                );
            };
            return [...node.inputs.map(mapProp('input')), ...node.outputs.map(mapProp('output'))];
        };

        const collapsedProperties = (node: Node) => {
            const dot = (conn: Endpoint, key: string, index: number, size: number) => {
                const style = () => {
                    const radius = 14;
                    const angle = size === 1 ? 0 : (index - size / 2 + 0.5) * Math.PI / 3;
                    if (conn.kind === 'input') {
                        const center = { x: -11, y: 0 };
                        return {
                            top: `${center.y + radius * Math.sin(angle)}px`,
                            left: `${center.x + radius * Math.cos(angle)}px`
                        };
                    }
                    else if (conn.kind === 'output') {
                        const center = { x: -3, y: 0 };
                        return {
                            top: `${center.y + radius * Math.sin(angle)}px`,
                            left: `${center.x - radius * Math.cos(angle)}px`
                        };
                    }
                };
                return <div
                    style={style()}
                    key={key}
                    onMouseDown={this.onCreateConnectionStarted.bind(this, conn)}
                    onMouseUp={this.onCreateConnectionEnded.bind(this, conn)}
                    ref={this.setConnectionEndpoint.bind(this, conn)}
                    className={`dot ${conn.kind}`} />;
            };
            const mapProp = (kind: Endpoint['kind'], size: number) => (prop: BaseConnection, i: number) => {
                const key = Endpoint.computeId(node.id, i, kind);
                return dot({ nodeId: node.id, connectionId: i, kind: kind }, key, i, size);
            };

            const inputs = <div key={node.id + 'inputs'} className="inputs">{node.inputs.map(mapProp('input', node.inputs.length))}</div>;
            const outputs = <div key={node.id + 'outputs'} className="outputs">{node.outputs.map(mapProp('output', node.outputs.length))}</div>;

            return [inputs, outputs];
        };

        const nodes = props.nodes.map(node => {
            const nodeState = state.nodesState.get(node.id);
            const { isCollapsed } = nodeState;
            const isSelected = this.state.selection && this.state.selection.id === node.id;
            return (
                <div onClick={this.select.bind(this, 'node', node.id)} key={node.id} style={nodeStyle(nodeState.pos)}
                    className={`node ${isCollapsed ? 'collapsed' : ''} ${isSelected ? 'selected' : ''}`}>
                    <div className="header" >
                        <div onClick={this.toggleExpandNode.bind(this, node.id)} className="expander" >
                            <div className={`icon ${isCollapsed ? 'arrow-down' : 'arrow-right'}`} />
                        </div>
                        <span onMouseDown={this.onDragStarted.bind(this, node.id)} >{node.name}</span>
                        {isCollapsed ? collapsedProperties(node) : ''}
                    </div>
                    {isCollapsed ? '' : <div className="body">
                        {props.config.resolver(node.payload)}
                        {properties(node)}
                    </div>}
                </div>
            );
        });

        const connections: { out: Endpoint, in: Endpoint }[] = [];

        for (let node of props.nodes) {
            let i = 0;
            for (let input of node.inputs) {
                if (input.connection === undefined) continue;
                if (Array.isArray(input.connection)) {
                    for (let conn of input.connection) {
                        const inputConn: Endpoint = { nodeId: node.id, connectionId: i, kind: 'input' };
                        const outputConn: Endpoint = { nodeId: conn.nodeId, connectionId: conn.port, kind: 'output' };
                        connections.push({ in: inputConn, out: outputConn });
                    }
                }
                else {
                    const inputConn: Endpoint = { nodeId: node.id, connectionId: i, kind: 'input' };
                    const outputConn: Endpoint = { nodeId: input.connection.nodeId, connectionId: input.connection.port, kind: 'output' };
                    connections.push({ in: inputConn, out: outputConn });
                }
                ++i;
            }
        }

        const connectionsLines = connections.map(conn => this.connection(conn.out, conn.in));
        const workingItem = state.workingItem && state.workingItem.type === 'connection' ? workingConnection(state.workingItem) : '';

        const { transformation } = state;

        const grid = () => {
            const { width, height } = state.componentSize;
            const dy = 18;
            const dx = 18;

            const draw = (element: HTMLCanvasElement) => {
                if (element === null) return;
                if (this.gridSize !== undefined && (this.gridSize.height === height && this.gridSize.width === width)) return;
                this.gridSize = { height, width };
                const ctx = element.getContext('2d');
                ctx.clearRect(0, 0, element.width, element.height);
                ctx.beginPath();
                ctx.strokeStyle = '#f2f2f2';
                for (let iy = 0; iy < height / dy; ++iy) {
                    const y = dy * (iy + 0.5);
                    ctx.moveTo(0, y);
                    ctx.lineTo(width, y);
                }

                for (let ix = 0; ix < width / dx; ++ix) {
                    const x = dx * (ix + 0.5);
                    ctx.moveTo(x, 0);
                    ctx.lineTo(x, height);
                }
                ctx.stroke();
            };
            return <canvas className="grid" width={width} height={height} ref={draw.bind(this)} />;
        };

        const nodesContainerStyle = {
            transform: `matrix(${transformation.zoom},0,0,${transformation.zoom},${transformation.dx},${transformation.dy})`
        };

        return (
            <div ref={this.onEditorUpdate.bind(this)}
                tabIndex={0} onKeyDown={this.onKeyDown.bind(this)} onWheel={this.onWheel.bind(this)}
                onMouseLeave={this.onDragEnded.bind(this)} onMouseMove={this.onDrag.bind(this)}
                onMouseDown={this.onMouseGlobalDown.bind(this)} onMouseUp={this.onDragEnded.bind(this)}
                className="react-flow-editor" >
                {grid()}
                <svg ref={this.updateEditorSize.bind(this)} className="connections" xmlns="http://www.w3.org/2000/svg">
                    {connectionsLines}
                    {workingItem}
                </svg>
                <div style={nodesContainerStyle} >
                    {nodes}
                </div>
            </div>
        );
    }

    createNewNode(type: string, factory: () => Node, pos: Vector2d) {

        const isInRange = (min: number, size: number, value: number) =>
            min <= value && (min + size) >= value;

        if (isInRange(this.editorBoundingRect.x, this.editorBoundingRect.width, pos.x) &&
            isInRange(this.editorBoundingRect.y, this.editorBoundingRect.height, pos.y)) {
        }
        else {
            return;
        }

        pos.x -= this.editorBoundingRect.x;
        pos.y -= this.editorBoundingRect.y;

        const createHash = () => {
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            const LENGTH = 6;
            return _.times(LENGTH)
                .map(() => Math.floor(Math.random() * chars.length))
                .map(i => chars.charAt(i))
                .reduce((p, c) => p + c, '');
        };

        const id = `${type}_${createHash()}`;
        const name = type;
        const proto = factory();

        // Make deep (enough) copy
        // const inputs = factory.inputs.map(input => ({ ...input }));
        // const outputs = template.outputs.map(output => ({ ...output }));

        this.props.nodes.push({ ...proto, id });

        this.setState(state => {
            state.nodesState.set(id, { isCollapsed: true, pos, size: { x: 100, y: 100 } });
            return { ...state };
        });

        this.props.config.onChanged({ type: 'NodeCreated', id });
    }

    onStartCreatingNewNode(type: string, factory: () => Node, pos: Vector2d, offset: Vector2d) {
        const node = document.createElement('div');
        node.className = 'node collapsed';
        node.style.top = `${pos.y}px`;
        node.style.left = `${pos.x}px`;
        node.style.position = 'absolute';

        const title = document.createElement('span');
        title.innerHTML = type;
        const header = document.createElement('div');
        header.className = 'header';
        header.appendChild(title);
        node.appendChild(header);

        const host = document.createElement('div');
        host.className = 'react-flow-creating-node';
        host.appendChild(node);

        document.body.appendChild(host);

        const onFinishCreatingNewNode = () => {
            const nodeRect = node.getBoundingClientRect();
            document.body.removeChild(host);
            document.body.removeEventListener('mouseup', onFinishCreatingNewNode);
            document.body.removeEventListener('mouseleave', onFinishCreatingNewNode);
            document.body.removeEventListener('mousemove', onMove);
            this.createNewNode(type, factory, Vector2d.floor({ x: nodeRect.left, y: nodeRect.top }));
        };

        const onMove = (e: MouseEvent) => {
            node.style.left = `${e.x - offset.x}px`;
            node.style.top = `${e.y - offset.y}px`;
        };

        document.body.addEventListener('mouseup', onFinishCreatingNewNode);
        document.body.addEventListener('mouseleave', onFinishCreatingNewNode);
        document.body.addEventListener('mousemove', onMove);
    }
}